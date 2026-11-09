import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fixture } from "./fixture.js";
import { ensureService } from "../src/plugin-entry.js";
async function freePort() {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as { port: number }).port;
  s.close();
  await once(s, "close");
  return port;
}
test("two plugin sessions auto-start and share one coordinator; disconnect preserves backend", async () => {
  const f = await fixture();
  f.config.dashboard = { port: await freePort() };
  const file = join(f.config.dataDir, "bridge.json");
  writeFileSync(file, JSON.stringify(f.config));
  const base = `http://127.0.0.1:${f.config.dashboard.port}`;
  const clients = [
    new Client({ name: "plugin-a", version: "1" }),
    new Client({ name: "plugin-b", version: "1" }),
  ];
  const transports = clients.map(
    () =>
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve("dist/plugin-entry.js")],
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(
              (v): v is [string, string] => v[1] !== undefined,
            ),
          ),
          AGENT_BRIDGE_CONFIG: file,
        },
        stderr: "pipe",
      }),
  );
  try {
    await Promise.all(clients.map((c, i) => c.connect(transports[i]!)));
    const health = await (await fetch(base + "/api/health")).json();
    assert.equal(health.service, "codex-agent-bridge");
    for (const c of clients) {
      assert.equal((await c.listTools()).tools.length, 17);
      const r = await c.callTool({
        name: "agent_get_config",
        arguments: { agentId: "hermes" },
      });
      assert.equal(JSON.parse((r.content as any)[0].text).agentId, "hermes");
    }
    await clients[0]!.close();
    assert.equal(
      (await (await fetch(base + "/api/health")).json()).pid,
      health.pid,
    );
    await clients[1]!.close();
    assert.equal(
      (await (await fetch(base + "/api/health")).json()).pid,
      health.pid,
    );
    const again = await ensureService(file);
    assert.equal(again.started, false);
    assert.equal(again.pid, health.pid);
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    try {
      const state = await (await fetch(base + "/api/state")).json();
      const r = await fetch(base + "/api/service/stop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-CSRF": state.csrf,
        },
        body: "{}",
      });
      assert.equal(r.status, 200);
    } finally {
      await f.close();
    }
  }
});
test("plugin refuses an occupied/incompatible port instead of launching another coordinator", async () => {
  const f = await fixture();
  f.config.dashboard = {
    port: Number(new URL((f.config.agents[0] as any).baseUrl).port),
  };
  const file = join(f.config.dataDir, "bridge.json");
  writeFileSync(file, JSON.stringify(f.config));
  try {
    await assert.rejects(ensureService(file), /incompatible service/);
    assert.equal(
      existsSync(join(f.config.dataDir, "service-start.lock")),
      false,
    );
  } finally {
    await f.close();
  }
});
