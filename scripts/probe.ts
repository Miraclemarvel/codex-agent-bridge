import { loadConfig } from "../src/config.js";
import { HermesAdapter } from "../src/adapters/hermes.js";
import { DeepSeekAdapter } from "../src/adapters/deepseek.js";
const config = loadConfig();
for (const agent of config.agents) {
  try {
    const caps = await (
      agent.kind === "hermes"
        ? new HermesAdapter(agent, config.requestTimeoutMs)
        : new DeepSeekAdapter(agent)
    ).capabilities();
    console.log(
      JSON.stringify(
        { id: agent.id, available: true, capabilities: caps },
        null,
        2,
      ),
    );
  } catch {
    console.error(
      JSON.stringify({
        id: agent.id,
        available: false,
        message:
          "Probe failed. Check endpoint, running gateway, and API key source.",
      }),
    );
    process.exitCode = 1;
  }
}
