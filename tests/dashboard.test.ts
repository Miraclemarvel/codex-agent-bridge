import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./fixture.js";
import { Coordinator } from "../src/coordinator.js";
import { startDashboard } from "../src/dashboard.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
test("dashboard serves real state, catalogs and guarded writes on loopback", async () => {
  const f = await fixture(),
    b = new Coordinator(f.config),
    d = await startDashboard(b, 0);
  try {
    const base = d.url.slice(0, -1);
    const root = await fetch(d.url);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /协作控制台/);
    assert.match(
      root.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    const state = await (await fetch(base + "/api/state")).json();
    assert.ok(state.csrf);
    assert.equal(state.agents[0].agentId, "hermes");
    assert.equal(JSON.stringify(state).includes("fixture-secret"), false);
    const foreign = await fetch(base + "/api/state", {
      headers: { Origin: "http://evil.test" },
    });
    assert.equal(foreign.status, 403);
    const body = {
      selection: { provider: "one", model: "m1" },
      expectedRevision: 0,
    };
    const noCsrf = await fetch(base + "/api/agents/hermes/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(noCsrf.status, 403);
    const catalog = await (
      await fetch(base + "/api/agents/hermes/models")
    ).json();
    assert.equal(catalog.providers[0].models[0].id, "m1");
    const testResponse = await fetch(base + "/api/agents/hermes/test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-CSRF": state.csrf,
        Origin: base,
      },
      body: JSON.stringify(body),
    });
    assert.equal(testResponse.status, 202);
    const receipt = await testResponse.json();
    assert.ok(receipt.taskId);
    const failedSave = await fetch(base + "/api/agents/hermes/defaults", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-CSRF": state.csrf,
      },
      body: JSON.stringify({ testId: receipt.id, expectedRevision: 0 }),
    });
    assert.equal(failedSave.status, 400);
    assert.equal(
      (await fetch(base + "/api/tasks/" + receipt.taskId)).status,
      200,
    );
    const client = new Client({ name: "dashboard-mcp-test", version: "1" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + "/mcp")),
      );
      assert.equal((await client.listTools()).tools.length, 17);
      const r = await client.callTool({
        name: "agent_get_config",
        arguments: { agentId: "hermes" },
      });
      assert.equal(JSON.parse((r.content as any)[0].text).agentId, "hermes");
    } finally {
      await client.close();
    }
    const blocked = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        Origin: "http://evil.test",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(blocked.status, 403);
  } finally {
    await d.close();
    await b.close();
    await f.close();
  }
});
