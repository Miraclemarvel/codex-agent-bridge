import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AntigravityAdapter } from "../src/adapters/antigravity.js";
import type { AntigravityConfig } from "../src/config.js";
import { Coordinator } from "../src/coordinator.js";
import { lastAttempt } from "../src/domain.js";

const fixture = `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
const [mode, ...args] = process.argv.slice(1);
const printIndex = args.indexOf("--print=");
assert.ok(printIndex >= 0);
assert.deepEqual(args.slice(printIndex, printIndex + 5), [
  "--print=", "--input-format", "stream-json", "--output-format", "stream-json",
]);
process.stdin.setEncoding("utf8");
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
assert.equal(request.event, "user");
assert.match(request.message.content, /项目看板/);
const emit = (value) => console.log(JSON.stringify(value));
emit({ event: "init", conversation_id: "agy-fixture-session" });
emit({ event: "step_update", step_update: { step_index: 1, step_type: "tool_call", state: "DONE" } });
if (mode === "route") {
  emit({ event: "result", result: { status: "SUCCESS", response: JSON.stringify(args.slice(0, printIndex)) } });
} else if (mode === "wait") {
  await delay(30000);
} else {
  writeFileSync("index.html", "<h1>项目看板</h1>");
  if (mode !== "missing") emit({
    event: "result",
    result: { status: mode === "denied" ? "WAITING" : "SUCCESS", response: mode === "empty" ? "" : "Preview: index.html" },
  });
  if (mode === "nonzero") process.exitCode = 1;
}
`;

function config(mode: string, cwd: string): AntigravityConfig {
  return {
    id: "antigravity",
    kind: "antigravity",
    command: process.execPath,
    args: ["--input-type=module", "--eval", fixture, "--", mode],
    cwd,
    inheritEnv: [],
    maxConcurrency: 1,
  };
}

test("the Antigravity protocol fits Bridge file capture and independent review", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-agy-"));
  const bridge = new Coordinator({
    dataDir: join(root, "state"),
    artifactRoots: [root],
    pollIntervalMs: 20,
    requestTimeoutMs: 1000,
    reviewer: "codex-test",
    agents: [config("success", root)],
  });
  try {
    const initial = bridge.submit({
      agentId: "antigravity",
      idempotencyKey: "dashboard",
      contract: {
        objective: "构建项目看板",
        baseline: "empty",
        scope: ["Only create the preview in the launch workspace"],
        deliverables: ["index.html"],
        acceptance: [
          {
            id: "preview",
            description: "The file renders the dashboard heading",
          },
        ],
      },
    });
    const deadline = Date.now() + 5000;
    let task = initial;
    while (task.reviewState !== "awaiting_review") {
      assert.ok(Date.now() < deadline, JSON.stringify(lastAttempt(task)));
      await bridge.tick();
      await delay(20);
      task = bridge.get(initial.id);
    }
    const run = lastAttempt(task);
    assert.equal(run.remote?.session_id, "agy-fixture-session");
    assert.equal(run.snapshot?.artifacts[0]?.text, "Preview: index.html");
    const captured = await bridge.capture(
      task.id,
      run.id,
      run.snapshot!.digest,
      [join(root, "index.html")],
    );
    const snapshot = lastAttempt(captured).snapshot!;
    const source = snapshot.artifacts.find(
      (item) => item.source === "local_file",
    );
    assert.equal(source?.encoding, "base64");
    assert.equal(
      Buffer.from(source!.text, "base64").toString("utf8"),
      "<h1>项目看板</h1>",
    );
    task = await bridge.review(task.id, {
      attemptId: run.id,
      digest: snapshot.digest,
      decision: "accept",
      checks: [
        {
          criterionId: "preview",
          passed: true,
          evidence: "Captured HTML contains the heading",
        },
      ],
      feedback: "Fixture handoff independently checked",
    });
    assert.equal(task.reviewState, "accepted");
  } finally {
    await bridge.close();
  }
});

test("an Antigravity headless run needs a successful result and exit", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-agy-"));
  for (const mode of ["missing", "nonzero", "denied", "empty", "wait"]) {
    const adapter = new AntigravityAdapter(config(mode, root));
    try {
      const key = await adapter.submit(
        { input: "项目看板", timeoutSeconds: 30 },
        mode,
      );
      if (mode === "wait") await adapter.stop(key);
      const deadline = Date.now() + 5000;
      let status = await adapter.status(key);
      while (status.status === "running" || status.status === "stopping") {
        assert.ok(Date.now() < deadline);
        await delay(20);
        status = await adapter.status(key);
      }
      assert.equal(status.status, mode === "wait" ? "cancelled" : "failed");
      assert.equal(status.output, undefined);
    } finally {
      await adapter.close();
    }
  }
});

test("Antigravity freezes defaults and applies only supplied task overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-agy-model-"));
  const profile = config("route", root);
  profile.agyDefaults = {
    model: "gemini-4-hydrogen",
    reasoningEffort: "high",
  };
  profile.args.push("--model", "old-model", "--effort=low");
  const bridge = new Coordinator({
    dataDir: join(root, "state"),
    pollIntervalMs: 20,
    requestTimeoutMs: 1000,
    reviewer: "codex-test",
    agents: [profile],
  });
  const base = {
    agentId: profile.id,
    contract: {
      objective: "项目看板",
      baseline: "test",
      scope: ["Return the received routing arguments"],
      deliverables: ["CLI arguments"],
      acceptance: [
        {
          id: "route",
          description: "Model and effort match the task settings",
        },
      ],
    },
  };
  try {
    const defaults = bridge.submit({ ...base, idempotencyKey: "defaults" });
    const override = bridge.submit({
      ...base,
      idempotencyKey: "override",
      reasoningEffort: "medium",
    });
    assert.throws(
      () =>
        bridge.submit({
          ...base,
          idempotencyKey: "override",
          reasoningEffort: "high",
        }),
      /already identifies a different task/,
    );
    const explicit = bridge.submit({
      ...base,
      idempotencyKey: "explicit",
      model: "gemini-4-argon-low",
      reasoningEffort: "low",
    });
    const modelOnly = bridge.submit({
      ...base,
      idempotencyKey: "model-only",
      model: "gemini-4-argon",
    });
    profile.agyDefaults = { model: "changed", reasoningEffort: "max" };
    for (const [task, model, effort] of [
      [defaults, "gemini-4-hydrogen", "high"],
      [override, "gemini-4-hydrogen", "medium"],
      [explicit, "gemini-4-argon-low", "low"],
      [modelOnly, "gemini-4-argon", "high"],
    ] as const) {
      const deadline = Date.now() + 5000;
      let run = lastAttempt(bridge.get(task.id));
      while (run.execution !== "completed") {
        assert.ok(Date.now() < deadline, JSON.stringify(run));
        await bridge.tick();
        await delay(20);
        run = lastAttempt(bridge.get(task.id));
      }
      assert.deepEqual(run.agySelection, { model, reasoningEffort: effort });
      assert.deepEqual(JSON.parse(run.snapshot!.artifacts[0]!.text), [
        `--model=${model}`,
        `--effort=${effort}`,
      ]);
    }
  } finally {
    await bridge.close();
  }
});
