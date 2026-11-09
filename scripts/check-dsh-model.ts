import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseDocument } from "yaml";
import { loadConfig } from "../src/config.js";
const config = loadConfig();
const agent = config.agents.find((a) => a.kind === "deepseek");
if (!agent || agent.kind !== "deepseek")
  throw new Error("DeepSeek agent is not configured");
const args = agent.args.filter((a) => a !== "--json");
args.push("--dump-config");
const child = spawn(agent.command, args, {
  cwd: agent.cwd,
  env: { ...process.env, ...agent.env },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "",
  stderr = "";
child.stdout.on("data", (c) => {
  output += c;
});
child.stderr.on("data", (c) => {
  stderr += c;
});
const timer = setTimeout(() => {
  child.kill();
}, 60000);
const code = await new Promise<number | null>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", resolve);
});
clearTimeout(timer);
if (code !== 0) {
  console.error(stderr.slice(-3000));
  throw new Error("DSH config composition failed");
}
const document = parseDocument(output);
const tree = document.toJS();
const nodes: any[] = [];
function walk(x: any) {
  if (!x || typeof x !== "object") return;
  if (x.id) nodes.push(x);
  for (const value of Object.values(x))
    if (typeof value === "object")
      Array.isArray(value) ? value.forEach(walk) : walk(value);
}
walk(tree);
const selection = nodes.find((n) => n.id === "agent-default-model")?.config;
const provider = nodes.find((n) => n.id === "llm-pi-ai")?.config?.providers?.[
  "opencode-go"
];
if (
  selection?.provider !== "opencode-go" ||
  selection?.model !== "deepseek-v4.1-flash" ||
  provider?.apiKeyEnv !== "OPENCODE_GO_API_KEY"
)
  throw new Error("Effective DSH route does not match requested configuration");
const evidence = {
  checkedAt: new Date().toISOString(),
  agentId: agent.id,
  provider: selection.provider,
  model: selection.model,
  credentialReference: provider.apiKeyEnv,
  verification:
    "Composed installed DSH headless configuration via --dump-config; no inference in this check",
};
mkdirSync("outputs", { recursive: true });
writeFileSync(
  "outputs/dsh-model-config.json",
  JSON.stringify(evidence, null, 2),
);
console.log(JSON.stringify(evidence, null, 2));
