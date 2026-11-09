import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import { modelSelectionSchema } from "./models-domain.js";
const hermesConfigSchema = z
  .object({
    id: z.string().regex(/^[\w-]+$/),
    kind: z.literal("hermes"),
    baseUrl: z.string().url(),
    apiKeyEnv: z.string().optional(),
    apiKeyFile: z.string().optional(),
    apiKeyFormat: z.enum(["dotenv", "hermes_yaml"]).optional(),
    modelDefaults: modelSelectionSchema.optional(),
    maxConcurrency: z.number().int().min(1).max(10).default(1),
  })
  .strict();
const deepseekConfigSchema = z
  .object({
    id: z.string().regex(/^[\w-]+$/),
    kind: z.literal("deepseek"),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1),
    env: z.record(z.string(), z.string()).default({}),
    inheritEnv: z.array(z.string()).default([]),
    modelDefaults: modelSelectionSchema.optional(),
    catalogModule: z.string().optional(),
    credentialsFile: z.string().optional(),
    maxConcurrency: z.number().int().min(1).max(10).default(1),
  })
  .strict();
export const configSchema = z
  .object({
    dataDir: z.string().default(".agent-bridge"),
    artifactRoots: z.array(z.string()).optional(),
    pollIntervalMs: z.number().int().min(20).max(60000).default(2000),
    requestTimeoutMs: z.number().int().min(100).max(60000).default(15000),
    reviewer: z.string().min(1).default("codex"),
    dashboard: z
      .object({ port: z.number().int().min(0).max(65535).default(4318) })
      .optional(),
    agents: z
      .array(
        z.discriminatedUnion("kind", [
          hermesConfigSchema,
          deepseekConfigSchema,
        ]),
      )
      .min(1),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.agents.map((a) => a.id)).size !== v.agents.length)
      ctx.addIssue({ code: "custom", message: "Agent IDs must be unique" });
    for (const a of v.agents) {
      if (a.kind !== "hermes") continue;
      const u = new URL(a.baseUrl);
      if (
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !["http:", "https:"].includes(u.protocol)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "baseUrl must be an HTTP(S) origin/profile prefix without credentials, query or hash",
        });
    }
  });
export type Config = z.infer<typeof configSchema>;
export type AgentConfig = Config["agents"][number];
export type HermesConfig = Extract<AgentConfig, { kind: "hermes" }>;
export type DeepSeekConfig = Extract<AgentConfig, { kind: "deepseek" }>;
export function loadConfig(
  path = process.env.AGENT_BRIDGE_CONFIG ?? "bridge.local.json",
): Config {
  const full = resolve(path);
  const config = configSchema.parse(
    JSON.parse(readFileSync(full, "utf8").replace(/^\uFEFF/, "")),
  );
  config.dataDir = resolve(dirname(full), config.dataDir);
  config.artifactRoots = config.artifactRoots?.map((p) =>
    resolve(dirname(full), p),
  );
  for (const a of config.agents) {
    if (a.kind === "hermes" && a.apiKeyFile)
      a.apiKeyFile = resolve(dirname(full), a.apiKeyFile);
    if (a.kind === "deepseek") {
      a.command = resolve(dirname(full), a.command);
      a.cwd = resolve(dirname(full), a.cwd);
      if (a.catalogModule)
        a.catalogModule = resolve(dirname(full), a.catalogModule);
      if (a.credentialsFile)
        a.credentialsFile = resolve(dirname(full), a.credentialsFile);
    }
  }
  return config;
}
export function readApiKey(config: HermesConfig): string {
  if (config.apiKeyEnv && process.env[config.apiKeyEnv])
    return process.env[config.apiKeyEnv]!.trim();
  if (config.apiKeyFile) {
    const source = readFileSync(config.apiKeyFile, "utf8");
    if (config.apiKeyFormat === "hermes_yaml") {
      const value = parseYaml(source)?.platforms?.api_server?.extra?.key;
      if (typeof value !== "string" || !value.trim())
        throw new Error(
          "Hermes YAML does not contain platforms.api_server.extra.key",
        );
      return value.trim();
    }
    const line = source
      .split(/\r?\n/)
      .find((l) => /^\s*(?:export\s+)?API_SERVER_KEY\s*=/.test(l));
    if (!line) throw new Error("apiKeyFile does not contain API_SERVER_KEY");
    const key = line
      .replace(/^\s*(?:export\s+)?API_SERVER_KEY\s*=\s*/, "")
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    if (!key) throw new Error("API_SERVER_KEY is empty");
    return key;
  }
  throw new Error(`No API key configured for ${config.id}`);
}
