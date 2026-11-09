import { fixture, contract } from "../tests/fixture.js";
import { Coordinator } from "../src/coordinator.js";
import { lastAttempt } from "../src/domain.js";
import { mkdirSync, writeFileSync } from "node:fs";
const f = await fixture();
const b = new Coordinator(f.config);
try {
  const task = b.submit({
    agentId: "hermes",
    idempotencyKey: "demo",
    contract,
  });
  for (const attemptNumber of [1, 2]) {
    await b.tick();
    const current = lastAttempt(b.get(task.id));
    const run = f.runs.get(current.runId!)!;
    run.status = "completed";
    run.output = JSON.stringify({ sum: attemptNumber === 1 ? 54 : 55 });
    await b.tick();
    const a = lastAttempt(b.get(task.id)),
      actual = JSON.parse(a.snapshot!.artifacts[0]!.text).sum;
    const passed = actual === (10 * 11) / 2;
    const reviewed = await b.review(task.id, {
      attemptId: a.id,
      digest: a.snapshot!.digest,
      decision: passed ? "accept" : "rework",
      checks: [
        {
          criterionId: "sum",
          passed,
          evidence: `Independent arithmetic 10*11/2=55; delivered sum=${actual}`,
        },
      ],
      feedback: passed
        ? "Numeric result independently verified."
        : "The delivered sum is wrong. Return sum 55.",
    });
    console.log(
      JSON.stringify({
        attempt: attemptNumber,
        actual,
        review: reviewed.reviewState,
      }),
    );
    if (!passed) await b.rework(task.id, reviewed.reviews.at(-1)!.id);
  }
  mkdirSync("outputs", { recursive: true });
  writeFileSync(
    "outputs/demo-evidence.json",
    JSON.stringify(
      {
        environment: "local mock Hermes HTTP server; no model invocation",
        task: b.get(task.id),
        events: b.events(task.id),
      },
      null,
      2,
    ),
  );
} finally {
  await b.close();
  await f.close();
}
