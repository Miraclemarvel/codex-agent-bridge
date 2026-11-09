import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp.js";
import { Coordinator } from "../src/coordinator.js";
import { fixture, contract } from "./fixture.js";
test("MCP schemas, tool discovery, argument validation, errors and submission", async () => {
  const f = await fixture(),
    b = new Coordinator(f.config),
    server = createMcpServer(b);
  const client = new Client({ name: "test", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(s);
    await client.connect(c);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 17);
    const r = await client.callTool({
      name: "task_submit",
      arguments: { agentId: "hermes", idempotencyKey: "mcp-1", contract },
    });
    assert.ok(!r.isError);
    const task = JSON.parse((r.content as any)[0].text);
    assert.equal(task.reviewState, "pending");
    const bad = await client.callTool({
      name: "task_get",
      arguments: { taskId: "invalid" },
    });
    assert.equal(bad.isError, true);
    const missing = await client.callTool({
      name: "task_get",
      arguments: { taskId: "00000000-0000-4000-8000-000000000000" },
    });
    assert.equal(missing.isError, true);
    assert.match((missing.content as any)[0].text, /NOT_FOUND/);
  } finally {
    await client.close();
    await server.close();
    await b.close();
    await f.close();
  }
});
