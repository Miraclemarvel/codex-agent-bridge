import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import type { Coordinator } from "./coordinator.js";
import { HermesAdapter } from "./adapters/hermes.js";
import { sha256 } from "./artifacts.js";
import {
  modelSelectionSchema,
  type ModelSelection,
  type ModelBinding,
  type ModelCatalog,
} from "./models-domain.js";
import { requireThat, now, lastAttempt, terminal } from "./domain.js";
type Version = {
  revision: number;
  selection: ModelSelection | null;
  createdAt: string;
  testId?: string;
  restoredFrom?: number;
};
type ModelTest = {
  id: string;
  taskId: string;
  agentId: string;
  baseRevision: number;
  selection: ModelSelection;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  catalogListed?: boolean;
};
type State = { versions: Version[]; tests: ModelTest[] };
export class ModelManager {
  private catalogs = new Map<string, ModelCatalog>();
  constructor(private bridge: Coordinator) {
    for (const a of bridge.config.agents)
      if (!bridge.store.value(this.key(a.id)))
        bridge.store.setValue(this.key(a.id), {
          versions: [
            {
              revision: 0,
              selection: a.modelDefaults ?? null,
              createdAt: now(),
            },
          ],
          tests: [],
        });
  }
  private key(id: string) {
    return "models:" + id;
  }
  private agent(id: string) {
    const a = this.bridge.config.agents.find((a) => a.id === id);
    requireThat(a, "UNKNOWN_AGENT", "Agent is not configured");
    return a;
  }
  private state(id: string) {
    this.agent(id);
    return this.bridge.store.value<State>(this.key(id))!;
  }
  binding(id: string): ModelBinding {
    const v = this.state(id).versions.at(-1)!;
    return { revision: v.revision, selection: structuredClone(v.selection) };
  }
  private testResult(t: ModelTest) {
    const a = lastAttempt(this.bridge.get(t.taskId));
    let status = "running",
      error: string | undefined;
    const runtime = a.remote?.runtime as
      { provider?: string; model?: string } | undefined;
    const actual =
      runtime?.provider && runtime?.model
        ? { provider: runtime.provider, model: runtime.model }
        : null;
    if (a.execution === "unknown") {
      status = "failed";
      error = "Execution outcome unknown; inspect the test task";
    } else if (terminal.has(a.execution)) {
      const output = a.snapshot?.artifacts
        .find((x) => x.source === "agent_report")
        ?.text.trim();
      status =
        a.execution === "completed" && output === "BRIDGE_MODEL_OK"
          ? "passed"
          : "failed";
      if (status === "failed")
        error = "The test did not complete with the expected response";
      if (
        actual &&
        (actual.provider !== t.selection.provider ||
          actual.model !== t.selection.model)
      ) {
        status = "failed";
        error = "Actual model differs from the requested route";
      }
      if (t.catalogListed === false && !actual) {
        status = "failed";
        error =
          "A catalog-external model requires an exact actual-model report before it can be saved";
      }
    }
    return { ...t, status, error, actual, execution: a.execution };
  }
  get(id: string) {
    const a = this.agent(id),
      s = this.state(id);
    return {
      agentId: id,
      kind: a.kind,
      current: s.versions.at(-1)!,
      history: [...s.versions].reverse(),
      tests: s.tests.map((t) => this.testResult(t)).reverse(),
    };
  }
  async catalog(id: string, refresh = false): Promise<ModelCatalog> {
    const cached = this.catalogs.get(id);
    if (cached && !refresh && Date.now() - Date.parse(cached.fetchedAt) < 60000)
      return cached;
    const a = this.agent(id);
    let result: ModelCatalog;
    if (a.kind === "hermes") {
      const raw = await new HermesAdapter(
        a,
        this.bridge.config.requestTimeoutMs,
      ).modelOptions(refresh);
      const rows = Array.isArray(raw.providers) ? raw.providers : [];
      result = {
        source: "Hermes /api/model/options",
        fetchedAt: now(),
        credentialRefs: [],
        providers: rows.map((p: any) => ({
          id: String(p.slug),
          name: String(p.name ?? p.slug),
          available: p.authenticated === true,
          models: (Array.isArray(p.models) ? p.models : []).map((m: any) => {
            const id = typeof m === "string" ? m : String(m.id);
            const c = p.capabilities?.[id];
            return {
              id,
              name: typeof m === "string" ? m : String(m.name ?? id),
              reasoningEfforts: Array.isArray(c?.reasoning_efforts)
                ? c.reasoning_efforts
                : [],
            };
          }),
        })),
      };
    } else {
      requireThat(
        a.catalogModule,
        "NO_CATALOG",
        "Configure the installed DSH model catalog module",
      );
      const [all, core] = await Promise.all([
        import(pathToFileURL(a.catalogModule).href),
        import(
          pathToFileURL(
            a.catalogModule.replace(/providers[\\/]all\.js$/, "models.js"),
          ).href
        ),
      ]);
      const models = all.builtinModels();
      let credentialRefs: string[] = [];
      if (a.credentialsFile) {
        const doc = parse(readFileSync(a.credentialsFile, "utf8"));
        credentialRefs = [
          ...new Set(
            Object.values(doc)
              .flatMap((v) =>
                v && typeof v === "object" ? Object.keys(v) : [],
              )
              .filter((k) => /^[A-Z_][A-Z0-9_]*$/.test(k)),
          ),
        ];
      }
      result = {
        source: "Installed DSH pi-ai catalog",
        fetchedAt: now(),
        credentialRefs,
        providers: models.getProviders().map((p: any) => ({
          id: p.id,
          name: p.name ?? p.id,
          available: true,
          models: models.getModels(p.id).map((m: any) => ({
            id: m.id,
            name: m.name ?? m.id,
            reasoningEfforts: core
              .getSupportedThinkingLevels(m)
              .filter((x: string) => x !== "off"),
          })),
        })),
      };
    }
    this.catalogs.set(id, result);
    return result;
  }
  async test(id: string, input: unknown, expectedRevision: number) {
    const selection = modelSelectionSchema.parse(input),
      a = this.agent(id),
      state = this.state(id),
      current = state.versions.at(-1)!;
    requireThat(
      current.revision === expectedRevision,
      "CONFIG_CONFLICT",
      "Configuration changed; refresh before testing",
    );
    const catalog = await this.catalog(id),
      provider = catalog.providers.find((p) => p.id === selection.provider),
      model = provider?.models.find((m) => m.id === selection.model);
    requireThat(
      provider,
      "UNKNOWN_PROVIDER",
      "The selected provider is not in the actual catalog",
    );
    requireThat(
      a.kind === "deepseek" || provider.available,
      "PROVIDER_UNAVAILABLE",
      "Provider is not authenticated on the agent",
    );
    requireThat(
      !selection.reasoningEffort ||
        model?.reasoningEfforts.includes(selection.reasoningEffort),
      "UNSUPPORTED_EFFORT",
      "Reasoning effort is not advertised for this model",
    );
    if (a.kind === "deepseek")
      requireThat(
        selection.credentialRef &&
          catalog.credentialRefs.includes(selection.credentialRef),
        "MISSING_CREDENTIAL",
        "Select an existing credential reference",
      );
    else
      requireThat(
        !selection.credentialRef,
        "INVALID_CREDENTIAL",
        "Hermes manages provider credentials on its own server",
      );
    const latest = this.state(id);
    requireThat(
      latest.versions.at(-1)!.revision === expectedRevision,
      "CONFIG_CONFLICT",
      "Configuration changed during model discovery",
    );
    requireThat(
      !latest.tests.some((t) => this.testResult(t).status === "running"),
      "TEST_ALREADY_RUNNING",
      "A model test is already running for this agent",
    );
    const testId = randomUUID();
    const task = this.bridge.submit(
      {
        agentId: id,
        idempotencyKey: "model-test-" + testId,
        contract: {
          objective: "Return exactly BRIDGE_MODEL_OK with no other text.",
          baseline: "model-connection-test-v1",
          scope: [
            "Only respond with text. Do not call tools, read files, post messages, or modify anything.",
          ],
          deliverables: ["The exact response BRIDGE_MODEL_OK"],
          acceptance: [
            {
              id: "connection",
              description:
                "Successful inference through the explicitly requested model route",
            },
          ],
          timeoutSeconds: 90,
          maxAttempts: 1,
        },
      },
      { revision: expectedRevision, selection },
      "model_test",
    );
    const receipt: ModelTest = {
      id: testId,
      taskId: task.id,
      agentId: id,
      selection,
      catalogListed: !!model,
      baseRevision: expectedRevision,
      fingerprint: sha256(JSON.stringify(a)),
      createdAt: now(),
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
    // Re-read after catalog I/O to preserve changes made by another client.
    latest.tests.push(receipt);
    this.bridge.store.setValue(this.key(id), latest);
    return this.testResult(receipt);
  }
  save(
    id: string,
    testId: string,
    expectedRevision: number,
    restoredFrom?: number,
  ) {
    return this.bridge.store.transaction(() => {
      const a = this.agent(id),
        s = this.state(id),
        current = s.versions.at(-1)!;
      requireThat(
        current.revision === expectedRevision,
        "CONFIG_CONFLICT",
        "Configuration changed; refresh and retest",
      );
      const receipt = s.tests.find((t) => t.id === testId);
      requireThat(
        receipt &&
          receipt.baseRevision === expectedRevision &&
          receipt.agentId === id,
        "INVALID_TEST",
        "A test for this exact agent and configuration version is required",
      );
      requireThat(
        Date.parse(receipt.expiresAt) > Date.now() &&
          receipt.fingerprint === sha256(JSON.stringify(a)),
        "EXPIRED_TEST",
        "Model test expired or backend configuration changed",
      );
      requireThat(
        this.testResult(receipt).status === "passed",
        "TEST_NOT_PASSED",
        "A successful model test is required before saving",
      );
      if (restoredFrom !== undefined)
        requireThat(
          JSON.stringify(
            s.versions.find((v) => v.revision === restoredFrom)?.selection,
          ) === JSON.stringify(receipt.selection),
          "RESTORE_MISMATCH",
          "The tested model does not match the selected historical version",
        );
      s.versions.push({
        revision: current.revision + 1,
        selection: receipt.selection,
        testId,
        createdAt: now(),
        ...(restoredFrom !== undefined ? { restoredFrom } : {}),
      });
      this.bridge.store.setValue(this.key(id), s);
      return s.versions.at(-1)!;
    });
  }
}
