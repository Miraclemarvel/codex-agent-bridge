import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { once } from "node:events";
import { z } from "zod";
import { Coordinator } from "./coordinator.js";
import { loadConfig } from "./config.js";
import { BridgeError, contractSchema } from "./domain.js";
import { modelSelectionSchema } from "./models-domain.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp-tools.js";
import {
  APP_VERSION,
  SERVICE_NAME,
  serviceIdentity,
} from "./service-identity.js";
const testSchema = z
  .object({
    selection: modelSelectionSchema,
    expectedRevision: z.number().int().min(0),
  })
  .strict();
const saveSchema = z
  .object({
    testId: z.string().uuid(),
    expectedRevision: z.number().int().min(0),
    restoredFrom: z.number().int().min(0).optional(),
  })
  .strict();
const reviewSchema = z
  .object({
    attemptId: z.string().uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    decision: z.enum(["accept", "rework", "unverifiable"]),
    checks: z
      .array(
        z.object({
          criterionId: z.string(),
          passed: z.boolean(),
          evidence: z.string().min(1).max(50000),
        }),
      )
      .max(50),
    feedback: z.string().min(1).max(50000),
  })
  .strict();
export async function startDashboard(
  bridge: Coordinator,
  port = 4318,
  onShutdown?: () => Promise<void>,
) {
  const csrf = randomUUID(),
    assets = join(dirname(fileURLToPath(import.meta.url)), "..", "ui");
  let url = "";
  const server = createServer(async (req, res) => {
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(value));
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (req.headers.host !== new URL(url).host) {
        send({ code: "INVALID_HOST", message: "Invalid host" }, 403);
        return;
      }
      const u = new URL(req.url ?? "/", url);
      if (req.headers.origin && req.headers.origin !== url) {
        send(
          {
            code: "INVALID_ORIGIN",
            message: "Foreign origins are not allowed",
          },
          403,
        );
        return;
      }
      if (req.method === "GET" && u.pathname === "/api/health") {
        send({
          service: SERVICE_NAME,
          version: APP_VERSION,
          identity: serviceIdentity(bridge.config),
          pid: process.pid,
        });
        return;
      }
      if (u.pathname === "/mcp") {
        if (req.method !== "POST") {
          send(
            {
              code: "METHOD_NOT_ALLOWED",
              message: "Use MCP Streamable HTTP POST requests",
            },
            405,
          );
          return;
        }
        if (!req.headers["content-type"]?.startsWith("application/json")) {
          send(
            {
              code: "INVALID_CONTENT_TYPE",
              message: "Expected application/json",
            },
            415,
          );
          return;
        }
        let data = "",
          size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) {
            send({ code: "BODY_TOO_LARGE" }, 413);
            return;
          }
          data += chunk;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const mcp = createMcpServer(bridge);
        res.once("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, JSON.parse(data));
        return;
      }
      if (
        req.method === "GET" &&
        ["/", "/app.js", "/style.css"].includes(u.pathname)
      ) {
        res.setHeader(
          "Content-Type",
          u.pathname.endsWith(".js")
            ? "text/javascript; charset=utf-8"
            : u.pathname.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/html; charset=utf-8",
        );
        res.end(
          readFileSync(
            join(
              assets,
              u.pathname === "/" ? "index.html" : u.pathname.slice(1),
            ),
          ),
        );
        return;
      }
      if (req.method === "GET" && u.pathname === "/api/state") {
        send({
          version: APP_VERSION,
          csrf,
          agents: bridge.config.agents.map((a) => bridge.models.get(a.id)),
          tasks: bridge.list(),
        });
        return;
      }
      const agent =
        /^\/api\/agents\/([\w-]+)(?:\/(models|test|defaults))?$/.exec(
          u.pathname,
        );
      const task =
        /^\/api\/tasks\/([a-f0-9-]{36})(?:\/(review|rework|cancel|capture))?$/.exec(
          u.pathname,
        );
      if (req.method === "GET") {
        if (agent?.[2] === "models") {
          send(
            await bridge.models.catalog(
              agent[1]!,
              u.searchParams.get("refresh") === "1",
            ),
          );
          return;
        }
        if (task && !task[2]) {
          send({
            task: bridge.get(task[1]!),
            events: bridge.events(
              task[1]!,
              Number(u.searchParams.get("after") ?? 0),
            ),
          });
          return;
        }
        send({ code: "NOT_FOUND", message: "Not found" }, 404);
        return;
      }
      if (req.method !== "POST") {
        send(
          { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
          405,
        );
        return;
      }
      if (req.headers["x-bridge-csrf"] !== csrf) {
        send(
          { code: "CSRF_REQUIRED", message: "Refresh the dashboard session" },
          403,
        );
        return;
      }
      if (!req.headers["content-type"]?.startsWith("application/json")) {
        send(
          {
            code: "INVALID_CONTENT_TYPE",
            message: "Expected application/json",
          },
          415,
        );
        return;
      }
      let body = "",
        size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          send(
            { code: "BODY_TOO_LARGE", message: "Request exceeds 1 MiB" },
            413,
          );
          return;
        }
        body += chunk;
      }
      const raw = JSON.parse(body || "{}");
      if (u.pathname === "/api/service/stop") {
        z.object({}).strict().parse(raw);
        if (!onShutdown) {
          send(
            {
              code: "HOST_OWNED_SERVICE",
              message: "This service is managed by its MCP host",
            },
            409,
          );
          return;
        }
        const active = bridge
          .list()
          .filter(
            (t) =>
              !["completed", "failed", "cancelled", "interrupted"].includes(
                t.execution,
              ),
          );
        if (active.length) {
          send(
            {
              code: "ACTIVE_WORK",
              message:
                "Finish or reconcile active tasks before stopping the service",
            },
            409,
          );
          return;
        }
        res.once("finish", () => {
          void onShutdown();
        });
        send({ status: "stopping" });
        return;
      }
      if (agent?.[2] === "test") {
        const p = testSchema.parse(raw);
        send(
          await bridge.models.test(agent[1]!, p.selection, p.expectedRevision),
          202,
        );
        return;
      }
      if (agent?.[2] === "defaults") {
        const p = saveSchema.parse(raw);
        send(
          bridge.models.save(
            agent[1]!,
            p.testId,
            p.expectedRevision,
            p.restoredFrom,
          ),
        );
        return;
      }
      if (u.pathname === "/api/tasks") {
        send(
          bridge.submit(
            z
              .object({
                agentId: z.string(),
                idempotencyKey: z.string().min(1).max(255),
                contract: contractSchema,
              })
              .strict()
              .parse(raw),
          ),
          202,
        );
        return;
      }
      if (task) {
        const id = task[1]!;
        if (task[2] === "review") {
          send(await bridge.review(id, reviewSchema.parse(raw)));
          return;
        }
        if (task[2] === "rework") {
          const p = z
            .object({
              reviewId: z.string().uuid(),
              useLatestDefaults: z.boolean().default(false),
            })
            .strict()
            .parse(raw);
          send(await bridge.rework(id, p.reviewId, p.useLatestDefaults));
          return;
        }
        if (task[2] === "cancel") {
          z.object({}).strict().parse(raw);
          send(await bridge.cancel(id));
          return;
        }
        if (task[2] === "capture") {
          const p = z
            .object({
              attemptId: z.string().uuid(),
              digest: z.string().regex(/^[a-f0-9]{64}$/),
              paths: z.array(z.string().min(1)).min(1).max(16),
            })
            .strict()
            .parse(raw);
          send(await bridge.capture(id, p.attemptId, p.digest, p.paths));
          return;
        }
      }
      send({ code: "NOT_FOUND", message: "Not found" }, 404);
    } catch (e) {
      if (e instanceof BridgeError)
        send(
          { code: e.code, message: e.message },
          e.code === "CONFIG_CONFLICT" ? 409 : 400,
        );
      else if (e instanceof z.ZodError || e instanceof SyntaxError)
        send({ code: "INVALID_INPUT", message: "Invalid request fields" }, 400);
      else
        send(
          {
            code: "OPERATION_FAILED",
            message:
              "Operation failed; check the local agent connection and configuration",
          },
          502,
        );
    }
  });
  server.requestTimeout = 30000;
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  bridge.dashboardUrl = url + "/";
  writeFileSync(
    join(bridge.config.dataDir, "dashboard.json"),
    JSON.stringify({ url: bridge.dashboardUrl, pid: process.pid }),
  );
  return {
    url: bridge.dashboardUrl,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      bridge.dashboardUrl = undefined;
    },
  };
}
async function main() {
  const bridge = new Coordinator(loadConfig());
  bridge.start();
  let dashboard: Awaited<ReturnType<typeof startDashboard>>;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await dashboard?.close();
    await bridge.close();
  };
  dashboard = await startDashboard(
    bridge,
    bridge.config.dashboard?.port ?? 4318,
    close,
  );
  console.log("Agent Bridge dashboard: " + dashboard.url);
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Dashboard failed to start. Check whether another coordinator owns this data directory or port.",
    );
    process.exitCode = 1;
  });
