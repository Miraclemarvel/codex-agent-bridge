import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "./store.js";
import {
  contractSchema,
  lastAttempt,
  now,
  requireThat,
  terminal,
  type Task,
  type Attempt,
  type Check,
} from "./domain.js";
import { sha256, snapshot, captureFiles, filesCurrent } from "./artifacts.js";
import {
  HermesAdapter,
  HttpError,
  executionOf,
  type AgentAdapter,
} from "./adapters/hermes.js";
import type { Config } from "./config.js";
import { DeepSeekAdapter } from "./adapters/deepseek.js";
import { join } from "node:path";
import { ModelManager } from "./model-manager.js";
import type { ModelBinding } from "./models-domain.js";

export class Coordinator {
  readonly store: Store;
  readonly models: ModelManager;
  dashboardUrl?: string;
  private adapters: Map<string, AgentAdapter>;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private closed = false;
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    readonly config: Config,
    adapters?: Map<string, AgentAdapter>,
  ) {
    this.store = new Store(config.dataDir);
    this.adapters =
      adapters ??
      new Map(
        config.agents.map((a) => [
          a.id,
          a.kind === "hermes"
            ? new HermesAdapter(a, config.requestTimeoutMs)
            : new DeepSeekAdapter(
                a,
                join(config.dataDir, "model-overlays", a.id),
              ),
        ]),
      );
    this.models = new ModelManager(this);
    // A lost submission receipt is ambiguous. Do not silently create another run on restart.
    for (const t of this.store.all()) {
      const a = lastAttempt(t);
      if (a.execution === "submitting")
        this.change(t, "submission.unknown", () => {
          a.execution = "unknown";
          a.error =
            "Coordinator restarted before submission receipt; reconcile with Hermes before retrying.";
        });
    }
  }
  private async exclusive<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const work = prev.catch(() => {}).then(fn);
    this.locks.set(id, work);
    try {
      return await work;
    } finally {
      if (this.locks.get(id) === work) this.locks.delete(id);
    }
  }
  private change(t: Task, event: string, fn: () => void, data: unknown = {}) {
    this.store.transaction(() => {
      fn();
      this.store.save(t);
      this.store.event(t, event, data);
    });
  }
  private adapter(id: string) {
    const a = this.adapters.get(id);
    requireThat(a, "UNKNOWN_AGENT", "Agent is not configured");
    return a;
  }
  private attempt(number: number): Attempt {
    return {
      id: randomUUID(),
      number,
      sessionId: `codex-bridge-${randomUUID()}`,
      execution: "queued",
      createdAt: now(),
    };
  }
  async agents() {
    return Promise.all(
      this.config.agents.map(async (a) => {
        try {
          return {
            id: a.id,
            kind: a.kind,
            available: true,
            maxConcurrency: a.maxConcurrency,
            capabilities: await this.adapter(a.id).capabilities(),
          };
        } catch {
          return {
            id: a.id,
            kind: a.kind,
            available: false,
            error:
              "Capability probe failed; check endpoint and key configuration",
          };
        }
      }),
    );
  }
  submit(
    input: {
      agentId: string;
      idempotencyKey: string;
      contract: unknown;
    },
    modelOverride?: ModelBinding,
    purpose: "task" | "model_test" = "task",
  ) {
    requireThat(
      input.idempotencyKey.length >= 1 && input.idempotencyKey.length <= 255,
      "INVALID_KEY",
      "Provide an idempotency key of 1–255 characters",
    );
    this.adapter(input.agentId);
    const contract = contractSchema.parse(input.contract);
    const hash = sha256(JSON.stringify({ agentId: input.agentId, contract }));
    const existing = this.store.byKey(input.idempotencyKey);
    if (existing) {
      requireThat(
        existing.hash === hash,
        "IDEMPOTENCY_CONFLICT",
        "This key already identifies a different task",
      );
      return this.get(existing.task.id);
    }
    const t: Task = {
      id: randomUUID(),
      agentId: input.agentId,
      contract,
      createdAt: now(),
      reviewState: "pending",
      attempts: [this.attempt(1)],
      reviews: [],
      purpose,
    };
    lastAttempt(t).modelBinding = structuredClone(
      modelOverride ?? this.models.binding(input.agentId),
    );
    this.store.transaction(() => {
      this.store.insert(t, input.idempotencyKey, hash);
      this.store.event(t, "task.submitted", { agentId: t.agentId });
    });
    return t;
  }
  get(id: string) {
    const t = this.store.get(id),
      s = lastAttempt(t).snapshot;
    if (s) {
      t.deliveryCurrent = filesCurrent(s);
      if (t.reviewState === "accepted" && !t.deliveryCurrent)
        t.reviewState = "unverifiable";
    }
    return t;
  }
  list() {
    return this.store
      .all()
      .map((t) => this.get(t.id))
      .map((t) => ({
        id: t.id,
        agentId: t.agentId,
        objective: t.contract.objective,
        execution: lastAttempt(t).execution,
        reviewState: t.reviewState,
        attempt: lastAttempt(t).number,
        purpose: t.purpose ?? "task",
        requestedModel: lastAttempt(t).modelBinding ?? null,
        actualModel: lastAttempt(t).remote?.runtime ?? null,
      }));
  }
  events(id: string, after = 0) {
    this.get(id);
    return this.store.events(id, after);
  }
  async wait(id: string, after = 0, timeoutMs = 10000) {
    requireThat(
      timeoutMs >= 0 && timeoutMs <= 30000,
      "INVALID_TIMEOUT",
      "Wait must be between 0 and 30000 ms",
    );
    const end = Date.now() + timeoutMs;
    for (;;) {
      const events = this.events(id, after);
      if (events.length || Date.now() >= end || this.closed)
        return {
          task: this.get(id),
          events,
          nextCursor: events.at(-1)?.cursor ?? after,
        };
      await delay(Math.min(100, end - Date.now()));
    }
  }
  artifacts(id: string, attemptId?: string) {
    const t = this.get(id);
    const a = attemptId
      ? t.attempts.find((a) => a.id === attemptId)
      : lastAttempt(t);
    requireThat(a, "NOT_FOUND", "Attempt not found");
    return {
      attemptId: a.id,
      snapshot: a.snapshot ?? null,
      history: a.snapshotHistory ?? [],
      filesCurrent: a.snapshot ? filesCurrent(a.snapshot) : null,
    };
  }
  async capture(
    id: string,
    attemptId: string,
    digest: string,
    paths: string[],
  ) {
    return this.exclusive(id, async () => {
      const t = this.get(id),
        a = lastAttempt(t);
      requireThat(
        a.execution === "completed" && a.snapshot,
        "NOT_DELIVERED",
        "Capture requires a completed delivery",
      );
      requireThat(
        a.id === attemptId && a.snapshot.digest === digest,
        "STALE_DELIVERY",
        "Capture must identify the current delivery",
      );
      const next = captureFiles(
        a.snapshot,
        paths,
        this.config.artifactRoots ?? [],
      );
      this.change(
        t,
        "delivery.files_captured",
        () => {
          a.snapshotHistory ??= [];
          a.snapshotHistory.push(a.snapshot!);
          a.snapshot = next;
          t.reviewState = "awaiting_review";
          t.deliveryCurrent = true;
        },
        { digest: next.digest },
      );
      return t;
    });
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      // Tasks are visited in admission order. Unknown work still consumes a slot.
      for (const original of this.store.all())
        await this.exclusive(original.id, async () => {
          const t = this.get(original.id);
          const a = lastAttempt(t);
          const adapter = this.adapter(t.agentId);
          if (terminal.has(a.execution) || a.execution === "unknown") return;
          if (a.execution === "queued") {
            if (
              t.purpose === "model_test" &&
              Date.now() - Date.parse(t.createdAt) >
                t.contract.timeoutSeconds * 1000
            ) {
              this.change(t, "model_test.queue_timeout", () => {
                a.execution = "cancelled";
                a.error = "Model test timed out while queued";
              });
              return;
            }
            const active = this.store
              .all()
              .filter(
                (x) =>
                  x.agentId === t.agentId &&
                  !terminal.has(lastAttempt(x).execution) &&
                  lastAttempt(x).execution !== "queued",
              ).length;
            if (
              active >=
              this.config.agents.find((x) => x.id === t.agentId)!.maxConcurrency
            )
              return;
            try {
              const caps = await adapter.capabilities();
              const f = caps.features as Record<string, unknown> | undefined;
              requireThat(
                f?.run_submission === true && f.run_status === true,
                "UNSUPPORTED_AGENT",
                "Hermes must advertise run_submission and run_status",
              );
            } catch {
              return;
            } // Offline agents leave the task queued; no execution has started.
            this.change(t, "attempt.submitting", () => {
              a.execution = "submitting";
              a.startedAt = now();
              a.request = adapter.request(t.contract, a);
            });
            try {
              const runId = await adapter.submit(a.request!, a.id);
              this.change(
                t,
                "attempt.started",
                () => {
                  a.runId = runId;
                  a.execution = "running";
                },
                { attemptId: a.id, runId },
              );
            } catch (e) {
              const definitive =
                e instanceof HttpError &&
                [400, 401, 403, 404, 409, 422, 429].includes(e.statusCode);
              this.change(
                t,
                definitive ? "attempt.failed" : "submission.unknown",
                () => {
                  a.execution = definitive ? "failed" : "unknown";
                  a.error = definitive
                    ? "Hermes rejected admission"
                    : "Submission outcome unknown; no automatic replay";
                },
              );
            }
            return;
          }
          if (!a.runId) return;
          if (
            Date.now() - Date.parse(a.startedAt!) >
              t.contract.timeoutSeconds * 1000 &&
            !a.stopRequestedAt
          ) {
            // An expired task is stopped, never automatically passed or resubmitted.
            try {
              await adapter.stop(a.runId);
              this.change(t, "attempt.timeout_stop_requested", () => {
                a.stopRequestedAt = now();
                a.execution = "stopping";
              });
            } catch {}
          }
          try {
            const remote = await adapter.status(a.runId);
            const status = executionOf(remote.status);
            const safeRemote = {
              status: remote.status,
              session_id: remote.session_id,
              pending_controls: remote.pending_controls ?? [],
              execution_generation: remote.execution_generation,
              progress: remote.progress ?? null,
              usage: remote.usage ?? null,
              runtime: remote.runtime ?? null,
            };
            if (
              status !== a.execution ||
              JSON.stringify(safeRemote) !== JSON.stringify(a.remote)
            )
              this.change(
                t,
                "attempt.status",
                () => {
                  a.execution = status;
                  a.remote = safeRemote;
                  delete a.error;
                },
                {
                  status,
                  progress: safeRemote.progress,
                  pending_controls: safeRemote.pending_controls,
                },
              );
            if (status === "completed" && !a.snapshot) {
              this.change(
                t,
                "delivery.ready",
                () => {
                  a.snapshot = snapshot(remote.output);
                  t.reviewState = "awaiting_review";
                },
                { source: "agent_report" },
              );
            }
          } catch (e) {
            if (
              e instanceof HttpError &&
              [401, 403, 404].includes(e.statusCode)
            )
              this.change(t, "attempt.unknown", () => {
                a.execution = "unknown";
                a.error =
                  "Run cannot be reconciled; check Hermes before any retry";
              });
            else if (a.error !== "Status temporarily unavailable")
              this.change(t, "tracking.disconnected", () => {
                a.error = "Status temporarily unavailable";
              });
          }
        });
    } finally {
      this.ticking = false;
    }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.config.pollIntervalMs);
    void this.tick();
  }
  async cancel(id: string) {
    return this.exclusive(id, async () => {
      const t = this.get(id),
        a = lastAttempt(t);
      if (terminal.has(a.execution)) return t;
      if (a.execution === "queued") {
        this.change(t, "attempt.cancelled", () => {
          a.execution = "cancelled";
        });
        return t;
      }
      requireThat(
        a.runId && a.execution !== "unknown",
        "UNKNOWN_EXECUTION",
        "Cannot safely cancel an unidentified/unknown execution",
      );
      await this.adapter(t.agentId).stop(a.runId);
      this.change(t, "attempt.stop_requested", () => {
        a.stopRequestedAt = now();
        a.execution = "stopping";
      });
      return t;
    });
  }
  async reconcile(id: string) {
    return this.exclusive(id, async () => {
      const t = this.get(id),
        a = lastAttempt(t),
        adapter = this.adapter(t.agentId);
      requireThat(
        a.execution === "unknown",
        "NOT_UNKNOWN",
        "Only unknown executions need reconciliation",
      );
      if (a.runId) {
        const r = await adapter.status(a.runId),
          state = executionOf(r.status);
        requireThat(
          state !== "unknown",
          "UNKNOWN_EXECUTION",
          "Hermes still reports unknown; resolve the execution in Hermes before reconciling",
        );
        this.change(t, "attempt.reconciled", () => {
          a.execution = state;
          a.remote = { status: r.status };
          delete a.error;
          if (state === "completed") {
            a.snapshot = snapshot(r.output);
            t.reviewState = "awaiting_review";
          }
        });
        return t;
      }
      const caps = await adapter.capabilities();
      const idem = (caps.features as any)?.runs_idempotency;
      const ageSeconds =
        (Date.now() - Date.parse(a.startedAt ?? a.createdAt)) / 1000;
      requireThat(
        idem?.supported === true &&
          idem.durable === true &&
          Number(idem.retention_seconds) > ageSeconds + 60,
        "UNSAFE_REPLAY",
        "Durable admission deduplication window is not available; reconcile manually with the backend",
      );
      requireThat(
        a.request,
        "MISSING_REQUEST",
        "No exact saved request is available",
      );
      const runId = await adapter.submit(a.request, a.id);
      this.change(t, "attempt.reconciled", () => {
        a.runId = runId;
        a.execution = "running";
        delete a.error;
      });
      return t;
    });
  }
  async respond(
    id: string,
    input: {
      kind: "approval" | "clarify";
      requestId: string;
      executionGeneration: number;
      choice?: "once" | "deny";
      answer?: string;
    },
  ) {
    return this.exclusive(id, async () => {
      const t = this.get(id),
        a = lastAttempt(t);
      requireThat(
        a.runId && !terminal.has(a.execution) && a.execution !== "unknown",
        "NOT_RUNNING",
        "Run is not accepting controls",
      );
      const remote = await this.adapter(t.agentId).status(a.runId);
      const controls = Array.isArray(remote.pending_controls)
        ? remote.pending_controls
        : [];
      const current = controls.find(
        (c: Record<string, unknown>) =>
          (c.prompt_id ?? c.request_id) === input.requestId &&
          (c.execution_generation ?? remote.execution_generation) ===
            input.executionGeneration,
      );
      requireThat(
        current,
        "STALE_CONTROL",
        "The request identity/generation is no longer pending",
      );
      const kind = String(current.kind ?? current.type ?? "");
      requireThat(
        kind.includes(input.kind) ||
          (input.kind === "clarify" && kind.includes("clarification")),
        "CONTROL_KIND_MISMATCH",
        "Control kind does not match the pending request",
      );
      if (input.kind === "approval")
        requireThat(
          input.choice === "once" || input.choice === "deny",
          "INVALID_CONTROL",
          "Provide an explicit approval choice",
        );
      else
        requireThat(
          input.answer?.trim(),
          "INVALID_CONTROL",
          "Provide a clarification answer",
        );
      await this.adapter(t.agentId).respond(a.runId, input.kind, {
        request_id: input.requestId,
        execution_generation: input.executionGeneration,
        ...(input.kind === "approval"
          ? { choice: input.choice }
          : { answer: input.answer }),
      });
      this.change(t, "control.answered", () => {}, {
        requestId: input.requestId,
        kind: input.kind,
      });
      return t;
    });
  }
  async review(
    id: string,
    input: {
      attemptId: string;
      digest: string;
      decision: "accept" | "rework" | "unverifiable";
      checks: Check[];
      feedback: string;
    },
  ) {
    return this.exclusive(id, async () => {
      const t = this.get(id),
        a = lastAttempt(t);
      requireThat(
        a.execution === "completed" && a.snapshot,
        "NOT_DELIVERED",
        "A completed delivery is required",
      );
      requireThat(
        a.id === input.attemptId && a.snapshot.digest === input.digest,
        "STALE_DELIVERY",
        "Review must identify the latest attempt and exact delivery digest",
      );
      requireThat(
        filesCurrent(a.snapshot),
        "STALE_FILES",
        "Captured files changed or disappeared; capture a new snapshot and verify again",
      );
      requireThat(
        t.reviewState !== "accepted" && t.reviewState !== "needs_rework",
        "ALREADY_REVIEWED",
        "This attempt already has a final review",
      );
      const ids = new Set(t.contract.acceptance.map((c) => c.id));
      requireThat(
        input.checks.length === ids.size &&
          new Set(input.checks.map((c) => c.criterionId)).size === ids.size &&
          input.checks.every(
            (c) => ids.has(c.criterionId) && c.evidence.trim(),
          ),
        "INCOMPLETE_REVIEW",
        "Supply evidence for every declared criterion exactly once",
      );
      requireThat(
        input.decision !== "accept" || input.checks.every((c) => c.passed),
        "FAILED_CRITERIA",
        "Acceptance requires every criterion to pass",
      );
      requireThat(
        input.feedback.trim(),
        "MISSING_FEEDBACK",
        "Review needs a concrete explanation",
      );
      this.change(
        t,
        "review.recorded",
        () => {
          t.reviews.push({
            ...input,
            id: randomUUID(),
            reviewer: this.config.reviewer,
            createdAt: now(),
          });
          t.reviewState = {
            accept: "accepted",
            rework: "needs_rework",
            unverifiable: "unverifiable",
          }[input.decision] as Task["reviewState"];
        },
        { decision: input.decision, digest: input.digest },
      );
      return t;
    });
  }
  async rework(id: string, reviewId: string, useLatestDefaults = false) {
    return this.exclusive(id, async () => {
      const t = this.get(id),
        a = lastAttempt(t),
        r = t.reviews.at(-1);
      requireThat(
        t.reviewState === "needs_rework" &&
          r?.id === reviewId &&
          r.attemptId === a.id,
        "INVALID_REWORK",
        "Rework must reference the current failing review",
      );
      requireThat(
        t.attempts.length < t.contract.maxAttempts,
        "ATTEMPT_LIMIT",
        "Maximum attempts reached",
      );
      this.change(
        t,
        "rework.queued",
        () => {
          const next = this.attempt(a.number + 1);
          next.modelBinding = structuredClone(
            useLatestDefaults
              ? this.models.binding(t.agentId)
              : (a.modelBinding ?? { revision: -1, selection: null }),
          );
          next.feedback = JSON.stringify({
            previousAttemptId: a.id,
            previousDelivery: {
              digest: a.snapshot?.digest,
              report: a.snapshot?.artifacts
                .find((a) => a.source === "agent_report")
                ?.text.slice(0, 12000),
              files: a.snapshot?.artifacts
                .filter((a) => a.source === "local_file")
                .map(({ name, sha256, sourcePath }) => ({
                  name,
                  sha256,
                  sourcePath,
                })),
            },
            review: r,
          });
          t.attempts.push(next);
          t.reviewState = "pending";
        },
        { reviewId },
      );
      return t;
    });
  }
  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    while (this.ticking) await delay(20);
    await Promise.allSettled([...this.locks.values()]);
    await Promise.allSettled(
      [...this.adapters.values()].map((a) => a.close?.()),
    );
    this.store.close();
  }
}
