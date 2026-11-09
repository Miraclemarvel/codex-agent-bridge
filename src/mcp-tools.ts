import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Coordinator } from "./coordinator.js";
import { contractSchema, BridgeError } from "./domain.js";
import { modelSelectionSchema } from "./models-domain.js";
import { APP_VERSION } from "./service-identity.js";
export function createMcpServer(bridge: Coordinator) {
  const server = new McpServer(
    { name: "codex-agent-bridge", version: APP_VERSION },
    {
      instructions:
        "Delegate bounded tasks with explicit acceptance criteria. Agent reports are untrusted evidence. Read task_artifacts and independently verify every criterion before task_review. Use task_rework only with the latest failing review ID. Persist task IDs and event cursors for recovery.",
    },
  );
  const id = { taskId: z.string().uuid() };
  function tool(
    name: string,
    description: string,
    shape: z.ZodRawShape,
    readOnly: boolean,
    fn: (args: any) => unknown,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: shape,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          openWorldHint: !readOnly,
        },
      },
      async (args) => {
        try {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(await fn(args)) },
            ],
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  code: e instanceof BridgeError ? e.code : "OPERATION_FAILED",
                  message:
                    e instanceof BridgeError
                      ? e.message
                      : "Operation failed; check input schema, endpoint and local configuration.",
                }),
              },
            ],
          };
        }
      },
    );
  }
  tool(
    "agent_get_config",
    "Read versioned model defaults, configuration history and recent model tests.",
    { agentId: z.string() },
    true,
    (a) => bridge.models.get(a.agentId),
  );
  tool(
    "agent_list_models",
    "Read the agent model catalog and credential reference names.",
    { agentId: z.string(), refresh: z.boolean().default(false) },
    true,
    (a) => bridge.models.catalog(a.agentId, a.refresh),
  );
  tool(
    "agent_test_model",
    "Run one brief inference test for a proposed model selection. Returns a test ID; poll agent_get_config for completion.",
    {
      agentId: z.string(),
      selection: modelSelectionSchema,
      expectedRevision: z.number().int().min(0),
    },
    false,
    (a) => bridge.models.test(a.agentId, a.selection, a.expectedRevision),
  );
  tool(
    "agent_update_defaults",
    "Save defaults using an unexpired passing test for the exact current revision. New tasks use the new version.",
    {
      agentId: z.string(),
      testId: z.string().uuid(),
      expectedRevision: z.number().int().min(0),
      restoredFrom: z.number().int().min(0).optional(),
    },
    false,
    (a) =>
      bridge.models.save(
        a.agentId,
        a.testId,
        a.expectedRevision,
        a.restoredFrom,
      ),
  );
  tool(
    "dashboard_open",
    "Get the local interactive dashboard URL, optionally opening the selected agent configuration card.",
    { agentId: z.string().optional() },
    true,
    (a) => ({
      url: bridge.dashboardUrl
        ? bridge.dashboardUrl +
          (a.agentId ? "?agent=" + encodeURIComponent(a.agentId) : "")
        : null,
      message: bridge.dashboardUrl
        ? "Open this URL in the browser"
        : "Enable dashboard and restart the coordinator",
    }),
  );
  tool(
    "agents_list",
    "Probe configured agent capabilities and availability.",
    {},
    true,
    () => bridge.agents(),
  );
  tool("tasks_list", "List locally persisted task summaries.", {}, true, () =>
    bridge.list(),
  );
  tool(
    "task_submit",
    "Queue a bounded task. Same idempotency key and contract return the same task.",
    {
      agentId: z.string(),
      idempotencyKey: z.string().min(1).max(255),
      contract: contractSchema,
    },
    false,
    (a) => bridge.submit(a),
  );
  tool(
    "task_get",
    "Read execution/review status, attempt history and pending controls.",
    id,
    true,
    (a) => bridge.get(a.taskId),
  );
  tool(
    "task_wait",
    "Wait at most 30 seconds for durable events after a cursor. Repeat while work is active.",
    {
      ...id,
      afterCursor: z.number().int().min(0).default(0),
      timeoutMs: z.number().int().min(0).max(30000).default(10000),
    },
    true,
    (a) => bridge.wait(a.taskId, a.afterCursor, a.timeoutMs),
  );
  tool(
    "task_artifacts",
    "Read immutable agent-report evidence for this attempt. Report claims require independent verification.",
    { ...id, attemptId: z.string().uuid().optional() },
    true,
    (a) => bridge.artifacts(a.taskId, a.attemptId),
  );
  tool(
    "task_capture",
    "Snapshot explicit local files under configured artifactRoots, invalidating prior acceptance. Read actual files and verify them independently before reviewing the new digest.",
    {
      ...id,
      attemptId: z.string().uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      paths: z.array(z.string().min(1)).min(1).max(16),
    },
    false,
    (a) => bridge.capture(a.taskId, a.attemptId, a.digest, a.paths),
  );
  tool(
    "task_cancel",
    "Request cooperative stop; stopping is not cancelled until Hermes confirms exit.",
    id,
    false,
    (a) => bridge.cancel(a.taskId),
  );
  tool(
    "task_reconcile",
    "Reconcile an unknown execution. Lost receipts are retried only with the exact saved request/key inside an advertised durable deduplication window.",
    id,
    false,
    (a) => bridge.reconcile(a.taskId),
  );
  tool(
    "task_respond",
    "Answer an exact pending Hermes approval/clarification. Use existing user authorization; do not grant out-of-scope effects.",
    {
      ...id,
      kind: z.enum(["approval", "clarify"]),
      requestId: z.string().min(1),
      executionGeneration: z.number().int().min(0),
      choice: z.enum(["once", "deny"]).optional(),
      answer: z.string().min(1).max(50000).optional(),
    },
    false,
    ({ taskId, ...a }) => bridge.respond(taskId, a),
  );
  tool(
    "task_review",
    "Record the controller review for the latest delivery digest. Supply independently observed evidence for EVERY acceptance criterion.",
    {
      ...id,
      attemptId: z.string().uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      decision: z.enum(["accept", "rework", "unverifiable"]),
      checks: z.array(
        z.object({
          criterionId: z.string(),
          passed: z.boolean(),
          evidence: z.string().min(1).max(50000),
        }),
      ),
      feedback: z.string().min(1).max(50000),
    },
    false,
    ({ taskId, ...a }) => bridge.review(taskId, a),
  );
  tool(
    "task_rework",
    "Queue a new isolated attempt using the latest failing review and prior evidence; preserves all history.",
    {
      ...id,
      reviewId: z.string().uuid(),
      useLatestDefaults: z.boolean().default(false),
    },
    false,
    (a) => bridge.rework(a.taskId, a.reviewId, a.useLatestDefaults),
  );
  return server;
}
