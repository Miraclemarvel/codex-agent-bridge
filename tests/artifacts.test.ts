import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFiles, filesCurrent, snapshot } from "../src/artifacts.js";
import { fixture, contract } from "./fixture.js";
import { Coordinator } from "../src/coordinator.js";
import { lastAttempt } from "../src/domain.js";
test("local file snapshots retain exact bytes and detect later mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-test-")),
    path = join(root, "file.bin");
  writeFileSync(path, Buffer.from([0, 1, 255]));
  const captured = captureFiles(snapshot("report"), [path], [root]);
  assert.deepEqual(
    Buffer.from(captured.artifacts[1]!.text, "base64"),
    Buffer.from([0, 1, 255]),
  );
  assert.equal(filesCurrent(captured), true);
  writeFileSync(path, "new");
  assert.equal(filesCurrent(captured), false);
});
test("file capture rejects paths and junction targets outside allowed roots", () => {
  const base = mkdtempSync(join(tmpdir(), "artifact-root-")),
    root = join(base, "allowed"),
    outside = join(base, "allowed-sibling");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "file.txt"), "outside");
  assert.throws(
    () => captureFiles(snapshot("report"), [join(outside, "file.txt")], [root]),
    /outside configured roots/,
  );
  const link = join(root, "link");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => captureFiles(snapshot("report"), [join(link, "file.txt")], [root]),
    /outside configured roots/,
  );
});
test("capture refuses disabled roots, duplicate files and oversized files", () => {
  const root = mkdtempSync(join(tmpdir(), "artifact-limit-")),
    path = join(root, "large");
  writeFileSync(path, "x");
  assert.throws(
    () => captureFiles(snapshot("report"), [path], []),
    /artifactRoots/,
  );
  assert.throws(
    () => captureFiles(snapshot("report"), [path, path], [root]),
    /Duplicate/,
  );
  writeFileSync(path, Buffer.alloc(1024 * 1024 + 1));
  assert.throws(
    () => captureFiles(snapshot("report"), [path], [root]),
    /1 MiB/,
  );
});
test("acceptance binds captured files; changed files require recapture and new review", async () => {
  const f = await fixture();
  f.config.artifactRoots = [f.config.dataDir];
  const b = new Coordinator(f.config);
  try {
    let task = b.submit({
      agentId: "hermes",
      idempotencyKey: "file-review",
      contract,
    });
    await b.tick();
    const a = lastAttempt(b.get(task.id));
    const run = f.runs.get(a.runId!)!;
    run.status = "completed";
    run.output = "report";
    await b.tick();
    const file = join(f.config.dataDir, "result.txt");
    writeFileSync(file, "55");
    const initial = lastAttempt(b.get(task.id));
    task = await b.capture(task.id, initial.id, initial.snapshot!.digest, [
      file,
    ]);
    const captured = lastAttempt(task);
    const review = {
      attemptId: captured.id,
      digest: captured.snapshot!.digest,
      decision: "accept" as const,
      checks: [
        {
          criterionId: "sum",
          passed: true,
          evidence:
            "Controller read captured result.txt and independently checked 55",
        },
      ],
      feedback: "Verified file bytes and expected result",
    };
    await b.review(task.id, review);
    writeFileSync(file, "54");
    assert.equal(b.get(task.id).reviewState, "unverifiable");
    assert.equal(b.get(task.id).deliveryCurrent, false);
    await assert.rejects(b.review(task.id, review), /Captured files changed/);
    const next = await b.capture(
      task.id,
      captured.id,
      captured.snapshot!.digest,
      [file],
    );
    assert.equal(next.reviewState, "awaiting_review");
    assert.notEqual(lastAttempt(next).snapshot!.digest, review.digest);
    assert.equal(lastAttempt(next).snapshotHistory!.length, 2);
    await assert.rejects(b.review(task.id, review), /exact delivery/);
  } finally {
    await b.close();
    await f.close();
  }
});
