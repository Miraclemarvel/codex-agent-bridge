import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import { HermesAdapter } from "../src/adapters/hermes.js";
export const contract = {
  objective: "Return the sum of integers 1 through 10 as JSON",
  context: "",
  baseline: "fixture-v1",
  scope: ["Only return text; no file changes or external effects"],
  deliverables: ["A JSON object with sum"],
  acceptance: [{ id: "sum", description: "sum equals 55" }],
  maxAttempts: 3,
  timeoutSeconds: 30,
};
export async function fixture() {
  const runs = new Map<string, Record<string, any>>();
  const submissions: Record<string, any>[] = [];
  const keys = new Map<string, string>();
  const state = {
    reject: 0,
    loseReceipt: false,
    pollError: 0,
    denyCaps: false,
  };
  async function body(req: IncomingMessage) {
    let s = "";
    for await (const c of req) s += c;
    return s ? JSON.parse(s) : {};
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.end(JSON.stringify(value));
    };
    if (req.headers.authorization !== "Bearer fixture-secret") {
      send({ error: "unauthorized" }, 401);
      return;
    }
    if (req.url === "/v1/capabilities") {
      send({
        features: {
          run_submission: !state.denyCaps,
          run_status: true,
          run_stop: true,
          run_approval: true,
          runs_idempotency: {
            supported: true,
            durable: true,
            retention_seconds: 86400,
          },
        },
      });
      return;
    }
    if (req.url?.startsWith("/api/model/options")) {
      send({
        providers: [
          {
            slug: "one",
            name: "Provider One",
            authenticated: true,
            models: ["m1", "m2"],
            capabilities: { m1: { reasoning_efforts: ["low", "high"] } },
          },
          {
            slug: "two",
            name: "Provider Two",
            authenticated: true,
            models: ["n1"],
            capabilities: {},
          },
          { slug: "offline", authenticated: false, models: ["x"] },
        ],
      });
      return;
    }
    if (req.url === "/v1/runs" && req.method === "POST") {
      const b = await body(req);
      if (state.reject) {
        send({}, state.reject);
        return;
      }
      const key = String(req.headers["idempotency-key"]);
      let id = keys.get(key);
      if (!id) {
        id = `run_${runs.size + 1}`;
        keys.set(key, id);
        submissions.push(b);
        runs.set(id, {
          run_id: id,
          status: "running",
          execution_generation: 1,
          pending_controls: [],
        });
      }
      if (state.loseReceipt) {
        req.socket.destroy();
        return;
      }
      send({ run_id: id, status: "started" }, 202);
      return;
    }
    const parts = req.url?.split("/").filter(Boolean) ?? [];
    const run = runs.get(parts[2]!);
    if (!run) {
      send({}, 404);
      return;
    }
    if (parts[3] === "stop") {
      await body(req);
      run.status = "stopping";
      send({ status: "stopping" });
      return;
    }
    if (parts[3] === "approval" || parts[3] === "clarify") {
      run.lastControl = await body(req);
      run.pending_controls = [];
      run.status = "running";
      send({ ok: true });
      return;
    }
    if (state.pollError) {
      send({}, state.pollError);
      return;
    }
    send(run);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const config: Config = {
    dataDir: mkdtempSync(join(tmpdir(), "agent-bridge-test-")),
    pollIntervalMs: 30,
    requestTimeoutMs: 1000,
    reviewer: "codex-test",
    agents: [
      {
        id: "hermes",
        kind: "hermes",
        baseUrl: `http://127.0.0.1:${port}`,
        apiKeyEnv: "BRIDGE_FIXTURE_KEY",
        maxConcurrency: 1,
      },
    ],
  };
  process.env.BRIDGE_FIXTURE_KEY = "fixture-secret";
  return {
    config,
    runs,
    submissions,
    state,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}
