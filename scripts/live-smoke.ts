import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { lastAttempt, type Task } from "../src/domain.js";

// Uses the same stdio MCP connection a Codex host uses. Only the test task is created.
const client = new Client({
  name: "agent-bridge-live-verifier",
  version: "0.1.0",
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/mcp.js")],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (x): x is [string, string] => x[1] !== undefined,
      ),
    ),
    AGENT_BRIDGE_CONFIG: resolve("bridge.local.json"),
  },
  stderr: "pipe",
});
let activeId: string | undefined;
let activeKind = "unknown";
const transcript: unknown[] = [];
async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await client.callTool({ name, arguments: args });
  const blocks = r.content as { type: string; text?: string }[];
  const value = JSON.parse(blocks.find((c) => c.type === "text")!.text!);
  if (r.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  transcript.push({ tool: name, at: new Date().toISOString(), value });
  return value;
}
try {
  await client.connect(transport);
  console.log("Connected to stdio MCP server.");
  const agents = await call("agents_list");
  const requestedAgent = process.argv[2];
  const agent = agents.find(
    (a: any) => a.available && (!requestedAgent || a.id === requestedAgent),
  );
  if (!agent) throw new Error("No available agent");
  activeKind = agent.kind;
  let task: Task = await call("task_submit", {
    agentId: agent.id,
    idempotencyKey: `live-smoke-${randomUUID()}`,
    contract: {
      objective:
        "Integration-test deliverable: calculate the sum of integers 1 through 10 and return only a JSON object with numeric sum and stage.",
      context:
        'This explicitly tests a two-stage review/rework workflow. For attempt 1 return stage="draft". After reviewer feedback in a later attempt, return stage="final". Sum must be correct in both attempts. Do not call tools or read any files; only produce the requested JSON text.',
      baseline: "Text-only arithmetic integration fixture v1",
      scope: [
        "Only produce response text. No tool calls, file writes, external communications or deployments.",
      ],
      deliverables: ["A JSON object with sum and stage fields"],
      acceptance: [
        { id: "sum", description: "numeric sum is exactly 55" },
        {
          id: "stage",
          description:
            "Final acceptance requires stage exactly final; draft is returned for rework.",
        },
      ],
      maxAttempts: 2,
      timeoutSeconds: 180,
    },
  });
  activeId = task.id;
  console.log(`Submitted task ${task.id}`);
  for (let attemptNumber = 1; attemptNumber <= 2; attemptNumber++) {
    let cursor = 0;
    const deadline = Date.now() + 210000;
    while (lastAttempt(task).execution !== "completed") {
      const state = lastAttempt(task).execution;
      if (
        [
          "failed",
          "cancelled",
          "interrupted",
          "unknown",
          "waiting_for_approval",
          "waiting_for_input",
        ].includes(state)
      )
        throw new Error(`Task needs attention: ${state}`);
      if (Date.now() > deadline)
        throw new Error("Live smoke exceeded deadline");
      const update = await call("task_wait", {
        taskId: task.id,
        afterCursor: cursor,
        timeoutMs: 1000,
      });
      task = update.task;
      cursor = update.nextCursor;
      if (update.events.length)
        console.log(`Attempt ${attemptNumber}: ${lastAttempt(task).execution}`);
    }
    const { snapshot, attemptId } = await call("task_artifacts", {
      taskId: task.id,
    });
    const raw = snapshot.artifacts[0].text;
    let data: any;
    try {
      data = JSON.parse(
        raw.replace(/^\s*```(?:json)?\s*/, "").replace(/\s*```\s*$/, ""),
      );
    } catch {
      data = null;
    }
    const expected = Array.from({ length: 10 }, (_, i) => i + 1).reduce(
      (a, b) => a + b,
      0,
    );
    const checks = [
      {
        criterionId: "sum",
        passed: data?.sum === expected,
        evidence: `Verifier independently summed integers 1..10 = ${expected}; parsed output=${JSON.stringify(data)}`,
      },
      {
        criterionId: "stage",
        passed: data?.stage === "final",
        evidence: `Verifier parsed exact stage=${JSON.stringify(data?.stage)}; expected final.`,
      },
    ];
    const pass = checks.every((c) => c.passed);
    task = await call("task_review", {
      taskId: task.id,
      attemptId,
      digest: snapshot.digest,
      decision: pass ? "accept" : "rework",
      checks,
      feedback: pass
        ? "Independently verified exact numeric sum and final stage."
        : 'Draft is not final. Return only {"sum":55,"stage":"final"}; keep the numeric sum correct.',
    });
    console.log(
      `Attempt ${attemptNumber}: ${task.reviewState}, delivered ${raw}`,
    );
    if (pass) break;
    if (attemptNumber === 2)
      throw new Error("Real agent failed both allowed attempts");
    task = await call("task_rework", {
      taskId: task.id,
      reviewId: task.reviews.at(-1)!.id,
    });
  }
  mkdirSync("outputs", { recursive: true });
  writeFileSync(
    `outputs/live-${activeKind}-evidence.json`,
    JSON.stringify(
      {
        environment: `Real local ${activeKind} via stdio MCP; two-stage draft/final exercise`,
        task,
        transcript,
      },
      null,
      2,
    ),
  );
  if (task.reviewState !== "accepted" || task.attempts.length !== 2)
    throw new Error("Expected exactly two real attempts and final acceptance");
  console.log(
    `PASS: real ${activeKind} submission, tracking, independent rejection, rework and acceptance.`,
  );
} catch (e) {
  if (activeId)
    try {
      await call("task_cancel", { taskId: activeId });
    } catch {}
  mkdirSync("outputs", { recursive: true });
  writeFileSync(
    `outputs/live-${activeKind}-failure.json`,
    JSON.stringify(
      {
        environment: `Real local ${activeKind}`,
        taskId: activeId,
        error: String(e),
        transcript,
      },
      null,
      2,
    ),
  );
  console.error(String(e));
  process.exitCode = 1;
} finally {
  await client.close();
}
