import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { Coordinator } from "./coordinator.js";
import { loadConfig } from "./config.js";
import { startDashboard } from "./dashboard.js";
import { createMcpServer } from "./mcp-tools.js";
export { createMcpServer } from "./mcp-tools.js";
async function main() {
  const bridge = new Coordinator(loadConfig());
  bridge.start();
  const server = createMcpServer(bridge);
  const dashboard = bridge.config.dashboard
    ? await startDashboard(bridge, bridge.config.dashboard.port)
    : undefined;
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await dashboard?.close();
    await bridge.close();
    await server.close();
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  process.stdin.once("end", () => {
    void stop();
  });
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      "Agent bridge failed to start. Check AGENT_BRIDGE_CONFIG and data-directory ownership.",
    );
    process.exitCode = 1;
  });
