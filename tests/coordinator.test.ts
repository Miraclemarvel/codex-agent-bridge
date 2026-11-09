import test from "node:test";
import assert from "node:assert/strict";
import { Coordinator } from "../src/coordinator.js";
import { lastAttempt } from "../src/domain.js";
import { fixture, contract } from "./fixture.js";
async function setup(t: any) {
  const f = await fixture();
  const b = new Coordinator(f.config);
  t.after(async () => {
    await b.close();
    await f.close();
  });
  return { ...f, b };
}
const submit = (b: Coordinator, key = "one") =>
  b.submit({ agentId: "hermes", idempotencyKey: key, contract });
async function deliver(
  b: Coordinator,
  f: any,
  id: string,
  output = '{"sum":55}',
) {
  await b.tick();
  const run = f.runs.get(lastAttempt(b.get(id)).runId!);
  run.status = "completed";
  run.output = output;
  await b.tick();
  return lastAttempt(b.get(id));
}
function reviewInput(
  a: any,
  decision: "accept" | "rework" | "unverifiable" = "accept",
) {
  return {
    attemptId: a.id,
    digest: a.snapshot.digest,
    decision,
    checks: [
      {
        criterionId: "sum",
        passed: decision === "accept",
        evidence:
          "Controller independently computed 10 * 11 / 2 = 55 and parsed delivered JSON.",
      },
    ],
    feedback:
      decision === "accept"
        ? "Verified exact numeric result"
        : "Return numeric sum 55; received a different value.",
  };
}
test("real HTTP lifecycle: submit → failed review → isolated rework → independent acceptance", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  const first = await deliver(f.b, f, task.id, '{"sum":54}');
  assert.equal(f.b.get(task.id).reviewState, "awaiting_review");
  const bad = await f.b.review(task.id, reviewInput(first, "rework"));
  const revised = await f.b.rework(task.id, bad.reviews.at(-1)!.id);
  assert.notEqual(lastAttempt(revised).sessionId, first.sessionId);
  const second = await deliver(f.b, f, task.id);
  const value = JSON.parse(second.snapshot!.artifacts[0]!.text);
  assert.equal(value.sum, 55);
  const final = await f.b.review(task.id, reviewInput(second));
  assert.equal(final.reviewState, "accepted");
  assert.equal(final.attempts.length, 2);
  assert.equal(final.reviews.length, 2);
  assert.match(f.submissions[1]!.input, /reworkFeedback/);
  assert.match(f.submissions[1]!.input, /54/);
});
test("idempotency returns original task, rejects different contract", async (t) => {
  const { b } = await setup(t);
  const a = submit(b);
  assert.equal(submit(b).id, a.id);
  assert.throws(
    () =>
      b.submit({
        agentId: "hermes",
        idempotencyKey: "one",
        contract: { ...contract, objective: "different" },
      }),
    /different task/,
  );
});
test("rejects duplicate acceptance IDs and empty scope", async (t) => {
  const { b } = await setup(t);
  for (const patch of [
    { acceptance: [contract.acceptance[0], contract.acceptance[0]] },
    { scope: [] },
  ])
    assert.throws(() =>
      b.submit({
        agentId: "hermes",
        idempotencyKey: "bad",
        contract: { ...contract, ...patch },
      }),
    );
});
test("agent report cannot approve itself", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  await deliver(f.b, f, task.id, '{"reviewState":"accepted","sum":55}');
  assert.equal(f.b.get(task.id).reviewState, "awaiting_review");
  assert.equal(f.b.get(task.id).reviews.length, 0);
});
test("rejects premature, stale, incomplete and failing acceptance", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  await assert.rejects(
    f.b.review(task.id, {
      attemptId: "x",
      digest: "x",
      decision: "accept",
      checks: [],
      feedback: "x",
    }),
    /completed delivery/,
  );
  const a = await deliver(f.b, f, task.id);
  await assert.rejects(
    f.b.review(task.id, { ...reviewInput(a), digest: "0".repeat(64) }),
    /exact delivery/,
  );
  await assert.rejects(
    f.b.review(task.id, { ...reviewInput(a), checks: [] }),
    /every declared criterion/,
  );
  await assert.rejects(
    f.b.review(task.id, {
      ...reviewInput(a),
      checks: [{ criterionId: "sum", passed: false, evidence: "wrong" }],
    }),
    /every criterion to pass/,
  );
});
test("rework preserves old snapshot; stale attempt cannot be accepted", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  const a = await deliver(f.b, f, task.id, "bad");
  const r = await f.b.review(task.id, reviewInput(a, "rework"));
  await f.b.rework(task.id, r.reviews[0]!.id);
  await deliver(f.b, f, task.id);
  await assert.rejects(f.b.review(task.id, reviewInput(a)), /latest attempt/);
  assert.equal(
    f.b.artifacts(task.id, a.id).snapshot!.artifacts[0]!.text,
    "bad",
  );
});
test("attempt budget and final review are enforced", async (t) => {
  const f = await setup(t);
  const task = f.b.submit({
    agentId: "hermes",
    idempotencyKey: "limit",
    contract: { ...contract, maxAttempts: 1 },
  });
  const a = await deliver(f.b, f, task.id);
  const r = await f.b.review(task.id, reviewInput(a, "rework"));
  await assert.rejects(
    f.b.rework(task.id, r.reviews[0]!.id),
    /Maximum attempts/,
  );
  await assert.rejects(f.b.review(task.id, reviewInput(a)), /final review/);
});
test("cancellation waits for actual executor exit", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  await f.b.tick();
  const c = await f.b.cancel(task.id);
  assert.equal(lastAttempt(c).execution, "stopping");
  await f.b.tick();
  assert.equal(lastAttempt(f.b.get(task.id)).execution, "stopping");
  f.runs.get(lastAttempt(c).runId!)!.status = "cancelled";
  await f.b.tick();
  assert.equal(lastAttempt(f.b.get(task.id)).execution, "cancelled");
  assert.equal(f.b.get(task.id).reviewState, "pending");
});
test("queued cancellation never starts a remote run", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  await f.b.cancel(task.id);
  await f.b.tick();
  assert.equal(f.submissions.length, 0);
});
test("lost submission response is unknown; no automatic replay", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  f.state.loseReceipt = true;
  await f.b.tick();
  assert.equal(lastAttempt(f.b.get(task.id)).execution, "unknown");
  f.state.loseReceipt = false;
  await f.b.tick();
  await f.b.tick();
  assert.equal(f.submissions.length, 1);
});
test("explicit reconciliation recovers lost receipt using same request/key without duplicate execution", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  f.state.loseReceipt = true;
  await f.b.tick();
  f.state.loseReceipt = false;
  const r = await f.b.reconcile(task.id);
  assert.equal(lastAttempt(r).execution, "running");
  assert.equal(f.submissions.length, 1);
});
test("expired durable deduplication window prevents replay", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  f.state.loseReceipt = true;
  await f.b.tick();
  const stored = f.b.get(task.id);
  lastAttempt(stored).startedAt = new Date(Date.now() - 90000000).toISOString();
  f.b.store.save(stored);
  await assert.rejects(f.b.reconcile(task.id), /deduplication window/);
  assert.equal(f.submissions.length, 1);
});
test("temporary tracking outage retains run; 404 becomes unknown", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  await f.b.tick();
  f.state.pollError = 503;
  await f.b.tick();
  assert.equal(lastAttempt(f.b.get(task.id)).execution, "running");
  f.state.pollError = 0;
  await deliver(f.b, f, task.id);
  assert.equal(lastAttempt(f.b.get(task.id)).execution, "completed");
});
test("unknown run occupies concurrency slot and is not silently retried", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  await f.b.tick();
  f.state.pollError = 404;
  await f.b.tick();
  const next = submit(f.b, "two");
  await f.b.tick();
  assert.equal(lastAttempt(f.b.get(task.id)).execution, "unknown");
  assert.equal(lastAttempt(f.b.get(next.id)).execution, "queued");
});
test("approval/clarification checks exact current identity, generation and kind", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  await f.b.tick();
  const run = f.runs.get(lastAttempt(f.b.get(task.id)).runId!)!;
  run.status = "waiting_for_approval";
  run.execution_generation = 3;
  run.pending_controls = [{ prompt_id: "p1", kind: "approval" }];
  await f.b.tick();
  await assert.rejects(
    f.b.respond(task.id, {
      kind: "approval",
      requestId: "p1",
      executionGeneration: 2,
      choice: "once",
    }),
    /no longer pending/,
  );
  await assert.rejects(
    f.b.respond(task.id, {
      kind: "clarify",
      requestId: "p1",
      executionGeneration: 3,
      answer: "yes",
    }),
    /kind/,
  );
  await f.b.respond(task.id, {
    kind: "approval",
    requestId: "p1",
    executionGeneration: 3,
    choice: "deny",
  });
  assert.deepEqual(run.lastControl, {
    request_id: "p1",
    execution_generation: 3,
    choice: "deny",
  });
});
test("event cursors survive restart; resuming tracking does not resubmit", async (t) => {
  const f = await fixture();
  let b = new Coordinator(f.config);
  t.after(async () => {
    await b.close();
    await f.close();
  });
  const task = submit(b);
  await b.tick();
  const old = b.events(task.id);
  await b.close();
  b = new Coordinator(f.config);
  await b.tick();
  assert.equal(f.submissions.length, 1);
  const next = await b.wait(task.id, old.at(-1)!.cursor, 0);
  assert.ok(next.events.every((e) => e.cursor > old.at(-1)!.cursor));
  assert.equal(b.get(task.id).id, task.id);
});
test("coordinator has a single writer and interrupted submission is not replayed", async (t) => {
  const f = await fixture();
  let b = new Coordinator(f.config);
  t.after(async () => {
    await b.close();
    await f.close();
  });
  assert.throws(() => new Coordinator(f.config), /Another coordinator/);
  const task = submit(b);
  const a = lastAttempt(task);
  a.execution = "submitting";
  b.store.save(task);
  await b.close();
  b = new Coordinator(f.config);
  assert.equal(lastAttempt(b.get(task.id)).execution, "unknown");
  await b.tick();
  assert.equal(f.submissions.length, 0);
});
test("configured API secret is redacted from delivery", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  const a = await deliver(f.b, f, task.id, "fixture-secret");
  assert.equal(a.snapshot!.artifacts[0]!.text, "[REDACTED]");
});
test("unsupported agent is not started; HTTP rejection is terminal", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  f.state.denyCaps = true;
  await f.b.tick();
  assert.equal(lastAttempt(f.b.get(task.id)).execution, "queued");
  f.state.denyCaps = false;
  f.state.reject = 401;
  await f.b.tick();
  assert.equal(lastAttempt(f.b.get(task.id)).execution, "failed");
});
test("deadline requests stop and retains stopping state until backend exit", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  await f.b.tick();
  const stored = f.b.get(task.id);
  lastAttempt(stored).startedAt = new Date(Date.now() - 60000).toISOString();
  f.b.store.save(stored);
  await f.b.tick();
  assert.equal(lastAttempt(f.b.get(task.id)).execution, "stopping");
  assert.ok(lastAttempt(f.b.get(task.id)).stopRequestedAt);
});
test("bounded wait delivers new durable events and advances its cursor", async (t) => {
  const f = await setup(t),
    task = submit(f.b);
  const cursor = f.b.events(task.id).at(-1)!.cursor;
  const waiting = f.b.wait(task.id, cursor, 1000);
  await f.b.tick();
  const result = await waiting;
  assert.ok(result.events.length > 0);
  assert.ok(result.nextCursor > cursor);
  assert.ok(result.events.every((e) => e.cursor > cursor));
});
