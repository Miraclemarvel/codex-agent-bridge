import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DeepSeekAdapter } from "../src/adapters/deepseek.js";
import { Coordinator } from "../src/coordinator.js";
import { lastAttempt } from "../src/domain.js";
import { contract } from "./fixture.js";
import type { DeepSeekConfig } from "../src/config.js";
const config = (mode = "success"): DeepSeekConfig => ({
  id: "deepseek",
  kind: "deepseek",
  command: process.execPath,
  args: [resolve("tests/fake-dsh.mjs"), mode],
  cwd: process.cwd(),
  env: {},
  inheritEnv: [],
  maxConcurrency: 1,
});
async function settled(adapter: DeepSeekAdapter, id: string) {
  const end = Date.now() + 5000;
  for (;;) {
    const r = await adapter.status(id);
    if (r.status !== "running" && r.status !== "stopping") return r;
    if (Date.now() > end) throw new Error("Process did not settle");
    await delay(20);
  }
}
test("DeepSeek process lifecycle supports delivery, independent review and rework", async () => {
  const b = new Coordinator({
    dataDir: mkdtempSync(join(tmpdir(), "dsh-bridge-test-")),
    pollIntervalMs: 30,
    requestTimeoutMs: 1000,
    reviewer: "codex-test",
    agents: [config()],
  });
  try {
    let task = b.submit({
      agentId: "deepseek",
      idempotencyKey: "dsh-test",
      contract,
    });
    for (const n of [1, 2]) {
      await b.tick();
      const deadline = Date.now() + 5000;
      while (lastAttempt((task = b.get(task.id))).execution !== "completed") {
        assert.ok(Date.now() < deadline);
        await delay(20);
        await b.tick();
      }
      const a = lastAttempt(task),
        value = JSON.parse(a.snapshot!.artifacts[0]!.text);
      const passed = value.sum === 55;
      task = await b.review(task.id, {
        attemptId: a.id,
        digest: a.snapshot!.digest,
        decision: passed ? "accept" : "rework",
        checks: [
          {
            criterionId: "sum",
            passed,
            evidence: `Controller parsed sum=${value.sum}; independent arithmetic gives 55`,
          },
        ],
        feedback: passed ? "Verified" : "Correct sum to 55",
      });
      if (n === 1) task = await b.rework(task.id, task.reviews[0]!.id);
    }
    assert.equal(task.reviewState, "accepted");
    assert.equal(task.attempts.length, 2);
  } finally {
    await b.close();
  }
});
test("DeepSeek final frame alone cannot report completion before exit", async () => {
  const a = new DeepSeekAdapter(config("early-final"));
  try {
    await a.submit({ input: '{"attempt":1}' }, "one");
    await delay(60);
    assert.equal((await a.status("one")).status, "running");
    assert.equal((await settled(a, "one")).status, "completed");
  } finally {
    await a.close();
  }
});
test("DeepSeek nonzero exit cannot be passed by a final frame", async () => {
  const a = new DeepSeekAdapter(config("fail"));
  try {
    await a.submit({ input: '{"attempt":1}' }, "one");
    assert.equal((await settled(a, "one")).status, "failed");
  } finally {
    await a.close();
  }
});
test("DeepSeek cancellation only terminates the addressed owned process", async () => {
  const a = new DeepSeekAdapter(config("wait"));
  try {
    await a.submit({ input: "{}" }, "one");
    await a.submit({ input: "{}" }, "two");
    await a.stop("one");
    assert.equal((await settled(a, "one")).status, "cancelled");
    assert.equal((await a.status("two")).status, "running");
  } finally {
    await a.close();
  }
});
test("DeepSeek protocol corruption is a failed run", async () => {
  const a = new DeepSeekAdapter(config("malformed"));
  try {
    await a.submit({ input: "{}" }, "one");
    assert.equal((await settled(a, "one")).status, "failed");
  } finally {
    await a.close();
  }
});
test("DeepSeek restart never recreates an unknown process", async () => {
  const a = new DeepSeekAdapter(config());
  assert.equal((await a.status("unowned")).status, "unknown");
  await assert.rejects(a.stop("unowned"), /does not own/);
  await a.close();
});
test("DeepSeek freezes per-attempt model routing in an immutable overlay", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-model-patch-")),
    a = new DeepSeekAdapter(config(), root);
  try {
    await a.submit(
      {
        input: '{"attempt":1}',
        modelSelection: {
          provider: "opencode-go",
          model: "deepseek-v4.1-flash",
          reasoningEffort: "high",
          credentialRef: "OPENCODE_GO_API_KEY",
        },
      },
      "bound-attempt",
    );
    await settled(a, "bound-attempt");
    const rows = parse(readFileSync(join(root, "bound-attempt.yml"), "utf8"));
    assert.deepEqual(rows[0].config, {
      provider: "opencode-go",
      model: "deepseek-v4.1-flash",
      reasoningEffort: "high",
    });
    assert.equal(
      rows[1].config.providers["opencode-go"].apiKeyEnv,
      "OPENCODE_GO_API_KEY",
    );
    const fresh = new DeepSeekAdapter(config(), root);
    try {
      await assert.rejects(
        fresh.submit(
          {
            input: "{}",
            modelSelection: { provider: "other", model: "changed" },
          },
          "bound-attempt",
        ),
        /immutable model overlay/,
      );
    } finally {
      await fresh.close();
    }
  } finally {
    await a.close();
  }
});
