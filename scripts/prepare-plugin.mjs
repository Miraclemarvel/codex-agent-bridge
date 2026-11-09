import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
const root = resolve("."),
  market = join(root, "local-marketplace"),
  plugin = join(market, "plugins", "codex-agent-bridge");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
for (const dir of [
  ".codex-plugin",
  "skills/agent-collaboration",
  "skills/agent-bridge-setup",
])
  mkdirSync(join(plugin, dir), { recursive: true });
mkdirSync(join(market, ".agents", "plugins"), { recursive: true });
const manifest = {
  ...JSON.parse(readFileSync("plugin.json", "utf8")),
  version,
  description:
    "Delegate to Hermes and DeepSeek Harness from Codex; track tasks, review evidence, and configure models.",
  extensions: {
    "com.openai": {
      onboardingSkill: "./skills/agent-bridge-setup/SKILL.md",
      interface: {
        displayName: "Agent Bridge",
        shortDescription: "让 Codex 调度 Hermes 与 DSH，跟踪交付并独立验收",
        longDescription:
          "从 Codex 聊天派发任务给本机 Hermes 与 DeepSeek Harness，共用持久化任务服务；支持独立验收、返工和交互式模型配置。",
        developerName: "Local workspace",
        category: "Productivity",
        capabilities: ["Read", "Write"],
        defaultPrompt: [
          "让 Hermes 执行一个任务，由你跟踪并验收。",
          "打开 Agent Bridge，看一下各 Agent 的默认模型。",
        ],
      },
    },
  },
};
writeFileSync(
  join(plugin, "plugin.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
writeFileSync(
  join(plugin, ".codex-plugin", "plugin.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version,
      description: manifest.description,
      skills: "./skills/",
      mcpServers: "./.mcp.json",
      onboardingSkill: "./skills/agent-bridge-setup/SKILL.md",
    },
    null,
    2,
  ) + "\n",
);
const server = {
  type: "stdio",
  // The native Agent Plugins loader rejects absolute executable paths.
  command: "node",
  args: [join(root, "dist", "plugin-entry.js")],
  env: { AGENT_BRIDGE_CONFIG: join(root, "bridge.local.json") },
};
writeFileSync(
  join(plugin, "mcp.json"),
  JSON.stringify(
    {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: { "agent-bridge": server },
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  join(plugin, ".mcp.json"),
  JSON.stringify({ mcpServers: { "agent-bridge": server } }, null, 2) + "\n",
);
copyFileSync(
  "skills/agent-collaboration/SKILL.md",
  join(plugin, "skills/agent-collaboration/SKILL.md"),
);
copyFileSync(
  "skills/agent-bridge-setup/SKILL.md",
  join(plugin, "skills/agent-bridge-setup/SKILL.md"),
);
writeFileSync(
  join(market, ".agents", "plugins", "marketplace.json"),
  JSON.stringify(
    {
      name: "agent-bridge-local",
      interface: { displayName: "本机 Agent 协作" },
      plugins: [
        {
          name: manifest.name,
          source: { source: "local", path: "./plugins/codex-agent-bridge" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Productivity",
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
console.log(
  JSON.stringify(
    {
      marketplace: market,
      plugin,
      version,
      install:
        'codex plugin marketplace add "' +
        market +
        '" --json\ncodex plugin add codex-agent-bridge@agent-bridge-local --json',
    },
    null,
    2,
  ),
);
