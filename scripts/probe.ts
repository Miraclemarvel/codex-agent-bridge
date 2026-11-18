import { loadConfig } from "../src/config.js";
import { createAdapter } from "../src/adapters/create.js";
const config = loadConfig();
for (const agent of config.agents) {
  try {
    const caps = await createAdapter(
      agent,
      config.requestTimeoutMs,
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
          agent.kind === "antigravity"
            ? "Check the configured agy executable and workspace."
            : "Probe failed. Check endpoint, running gateway, and API key source.",
      }),
    );
    process.exitCode = 1;
  }
}
