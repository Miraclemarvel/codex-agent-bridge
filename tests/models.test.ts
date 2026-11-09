import test from "node:test";
import assert from "node:assert/strict";
import { fixture, contract } from "./fixture.js";
import { Coordinator } from "../src/coordinator.js";
import { lastAttempt } from "../src/domain.js";
const first = { provider: "one", model: "m1" },
  second = { provider: "one", model: "m2" };
async function setup(t: any) {
  const f = await fixture();
  f.config.agents[0]!.modelDefaults = first;
  f.config.agents[0]!.maxConcurrency = 5;
  const b = new Coordinator(f.config);
  t.after(async () => {
    await b.close();
    await f.close();
  });
  return { ...f, b };
}
async function passing(
  f: Awaited<ReturnType<typeof setup>>,
  selection = second,
  rev = 0,
  output = "BRIDGE_MODEL_OK",
  runtime?: unknown,
) {
  const receipt = await f.b.models.test("hermes", selection, rev);
  await f.b.tick();
  const a = lastAttempt(f.b.get(receipt.taskId));
  const run = f.runs.get(a.runId!)!;
  run.status = "completed";
  run.output = output;
  if (runtime) run.runtime = runtime;
  await f.b.tick();
  return receipt;
}
test("model catalog normalizes actual provider rows; unknown and unsupported selections do not create tests", async (t) => {
  const f = await setup(t);
  const c = await f.b.models.catalog("hermes");
  assert.equal(c.providers[0]!.models[0]!.id, "m1");
  assert.deepEqual(c.providers[0]!.models[0]!.reasoningEfforts, [
    "low",
    "high",
  ]);
  for (const selection of [
    { provider: "missing", model: "missing" },
    { provider: "offline", model: "x" },
    { ...first, reasoningEffort: "max" },
  ])
    await assert.rejects(f.b.models.test("hermes", selection, 0));
  assert.equal(f.b.list().length, 0);
});
test("catalog-external IDs require exact runtime confirmation, not only a successful reply", async (t) => {
  const f = await setup(t);
  const selection = { provider: "one", model: "custom-id" };
  const missing = await passing(f, selection);
  assert.throws(
    () => f.b.models.save("hermes", missing.id, 0),
    /successful model test/,
  );
  const exact = await passing(f, selection, 0, "BRIDGE_MODEL_OK", {
    provider: "one",
    model: "custom-id",
  });
  const saved = f.b.models.save("hermes", exact.id, 0);
  assert.equal(saved.selection?.model, "custom-id");
});
test("defaults require a passing exact test and CAS revision, persist history, freeze queued tasks", async (t) => {
  const f = await setup(t),
    receipt = await passing(f);
  const old = f.b.submit({
    agentId: "hermes",
    idempotencyKey: "old",
    contract,
  });
  const v = f.b.models.save("hermes", receipt.id, 0);
  assert.equal(v.revision, 1);
  assert.deepEqual(lastAttempt(f.b.get(old.id)).modelBinding, {
    revision: 0,
    selection: first,
  });
  const next = f.b.submit({
    agentId: "hermes",
    idempotencyKey: "new",
    contract,
  });
  assert.deepEqual(lastAttempt(next).modelBinding, {
    revision: 1,
    selection: second,
  });
  await f.b.tick();
  assert.equal(
    f.submissions.find((x) => x.session_id === lastAttempt(old).sessionId)!
      .model,
    "m1",
  );
  assert.equal(
    f.submissions.find((x) => x.session_id === lastAttempt(next).sessionId)!
      .model,
    "m2",
  );
  assert.throws(
    () => f.b.models.save("hermes", receipt.id, 0),
    /Configuration changed/,
  );
});
test("running, failed, expired, changed-backend and actual-model mismatch tests cannot save", async (t) => {
  const f = await setup(t);
  const pending = await f.b.models.test("hermes", first, 0);
  assert.throws(
    () => f.b.models.save("hermes", pending.id, 0),
    /successful model test/,
  );
  await f.b.cancel(pending.taskId);
  const bad = await passing(f, first, 0, "wrong");
  assert.throws(
    () => f.b.models.save("hermes", bad.id, 0),
    /successful model test/,
  );
  const wrongRoute = await passing(f, first, 0, "BRIDGE_MODEL_OK", {
    provider: "two",
    model: "n1",
  });
  assert.equal(f.b.models.get("hermes").tests[0]!.status, "failed");
  assert.throws(
    () => f.b.models.save("hermes", wrongRoute.id, 0),
    /successful model test/,
  );
  const good = await passing(f);
  const stored = f.b.store.value<any>("models:hermes");
  stored.tests.find((x: any) => x.id === good.id).expiresAt = new Date(
    0,
  ).toISOString();
  f.b.store.setValue("models:hermes", stored);
  assert.throws(() => f.b.models.save("hermes", good.id, 0), /expired/);
  assert.equal(f.b.models.binding("hermes").revision, 0);
});
test("restore is a newly tested version; mismatched history cannot be restored", async (t) => {
  const f = await setup(t);
  const r = await passing(f);
  f.b.models.save("hermes", r.id, 0);
  const wrong = await passing(f, second, 1);
  assert.throws(
    () => f.b.models.save("hermes", wrong.id, 1, 0),
    /historical version/,
  );
  const restore = await passing(f, first, 1);
  const result = f.b.models.save("hermes", restore.id, 1, 0);
  assert.equal(result.revision, 2);
  assert.equal(result.restoredFrom, 0);
  assert.equal(f.b.models.get("hermes").history.length, 3);
});
test("cross-provider defaults and explicitly changed rework use the right versions", async (t) => {
  const f = await setup(t);
  const tasks = ["keep", "change"].map((key) =>
    f.b.submit({ agentId: "hermes", idempotencyKey: key, contract }),
  );
  await f.b.tick();
  for (const task of tasks) {
    const a = lastAttempt(f.b.get(task.id));
    Object.assign(f.runs.get(a.runId!)!, {
      status: "completed",
      output: "bad",
    });
  }
  await f.b.tick();
  for (const task of tasks) {
    const a = lastAttempt(f.b.get(task.id));
    await f.b.review(task.id, {
      attemptId: a.id,
      digest: a.snapshot!.digest,
      decision: "rework",
      checks: [
        {
          criterionId: "sum",
          passed: false,
          evidence: "Controller parsed wrong result",
        },
      ],
      feedback: "Fix result",
    });
  }
  const r = await passing(f, { provider: "two", model: "n1" });
  f.b.models.save("hermes", r.id, 0);
  const keep = await f.b.rework(
    tasks[0]!.id,
    f.b.get(tasks[0]!.id).reviews[0]!.id,
  );
  const change = await f.b.rework(
    tasks[1]!.id,
    f.b.get(tasks[1]!.id).reviews[0]!.id,
    true,
  );
  assert.deepEqual(lastAttempt(keep).modelBinding?.selection, first);
  assert.deepEqual(lastAttempt(change).modelBinding?.selection, {
    provider: "two",
    model: "n1",
  });
  assert.equal(lastAttempt(change).modelBinding?.revision, 1);
});
test("model defaults and receipts survive coordinator restart", async (t) => {
  const f = await fixture();
  f.config.agents[0]!.modelDefaults = first;
  let b = new Coordinator(f.config);
  t.after(async () => {
    await b.close();
    await f.close();
  });
  const r = await b.models.test("hermes", second, 0);
  await b.tick();
  Object.assign(f.runs.get(lastAttempt(b.get(r.taskId)).runId!)!, {
    status: "completed",
    output: "BRIDGE_MODEL_OK",
  });
  await b.tick();
  b.models.save("hermes", r.id, 0);
  await b.close();
  b = new Coordinator(f.config);
  assert.deepEqual(b.models.binding("hermes"), {
    revision: 1,
    selection: second,
  });
  assert.equal(b.models.get("hermes").tests[0]!.status, "passed");
});
