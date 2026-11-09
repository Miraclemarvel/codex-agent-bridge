import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
const server = {
  type: "stdio",
  command: "node",
  args: [resolve("dist/plugin-entry.js")],
  env: { AGENT_BRIDGE_CONFIG: resolve("bridge.local.json") },
};
const http = process.argv.includes("--http");
const port =
  JSON.parse(readFileSync("bridge.local.json", "utf8")).dashboard?.port ?? 4318;
if (http && (!Number.isInteger(port) || port < 1 || port > 65535))
  throw new Error("A fixed dashboard port is required for HTTP manifests");
writeFileSync(
  "mcp.json",
  JSON.stringify(
    {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        "agent-bridge": http
          ? { type: "streamable-http", url: `http://127.0.0.1:${port}/mcp` }
          : server,
      },
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(
  ".mcp.json",
  JSON.stringify(
    {
      mcpServers: {
        "agent-bridge": http
          ? { type: "http", url: `http://127.0.0.1:${port}/mcp` }
          : server,
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Generated local mcp.json and .mcp.json with a portable Node command and absolute runtime/config paths.",
);
