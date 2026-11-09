import { z } from "zod";
import type { ModelBinding } from "./models-domain.js";
export const text = z.string().trim().min(1).max(50000);
export const contractSchema = z
  .object({
    objective: text,
    context: z.string().max(100000).default(""),
    baseline: text,
    scope: z.array(text).min(1).max(50),
    deliverables: z.array(text).min(1).max(50),
    acceptance: z
      .array(
        z.object({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          description: text,
        }),
      )
      .min(1)
      .max(50),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    timeoutSeconds: z.number().int().min(5).max(86400).default(1800),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.acceptance.map((c) => c.id)).size !== v.acceptance.length)
      ctx.addIssue({
        code: "custom",
        message: "Acceptance criterion IDs must be unique",
      });
  });
export type Contract = z.infer<typeof contractSchema>;
export type Execution =
  | "queued"
  | "submitting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "stopping"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";
export type ReviewState =
  "pending" | "awaiting_review" | "accepted" | "needs_rework" | "unverifiable";
export type Artifact = {
  name: string;
  text: string;
  sha256: string;
  source: "agent_report" | "local_file";
  sourcePath?: string;
  encoding?: "utf8" | "base64";
};
export type Snapshot = {
  digest: string;
  artifacts: Artifact[];
  createdAt: string;
};
export type Check = { criterionId: string; passed: boolean; evidence: string };
export type Review = {
  id: string;
  reviewer: string;
  attemptId: string;
  digest: string;
  decision: "accept" | "rework" | "unverifiable";
  checks: Check[];
  feedback: string;
  createdAt: string;
};
export type Attempt = {
  id: string;
  number: number;
  sessionId: string;
  execution: Execution;
  createdAt: string;
  startedAt?: string;
  runId?: string;
  request?: Record<string, unknown>;
  error?: string;
  remote?: Record<string, unknown>;
  snapshot?: Snapshot;
  snapshotHistory?: Snapshot[];
  feedback?: string;
  stopRequestedAt?: string;
  modelBinding?: ModelBinding;
};
export type Task = {
  id: string;
  agentId: string;
  contract: Contract;
  createdAt: string;
  reviewState: ReviewState;
  attempts: Attempt[];
  reviews: Review[];
  deliveryCurrent?: boolean;
  purpose?: "task" | "model_test";
};
export type BridgeEvent = {
  cursor: number;
  taskId: string;
  attemptId: string;
  type: string;
  data: unknown;
  createdAt: string;
};
export const terminal = new Set<Execution>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export const now = () => new Date().toISOString();
export const lastAttempt = (task: Task) => task.attempts.at(-1)!;
export class BridgeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireThat(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new BridgeError(code, message);
}
