import { loadConfig } from "../src/config.js";
import { probeService } from "../src/plugin-entry.js";
const config = loadConfig(),
  base = `http://127.0.0.1:${config.dashboard?.port ?? 4318}`;
if (!(await probeService(base, config))) {
  console.log("Agent Bridge is already stopped.");
} else {
  const state = await (await fetch(base + "/api/state")).json();
  const r = await fetch(base + "/api/service/stop", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-CSRF": state.csrf,
    },
    body: "{}",
  });
  if (!r.ok) {
    console.error(await r.text());
    process.exitCode = 1;
  } else
    console.log(
      "Agent Bridge shutdown requested; saved tasks and settings are retained.",
    );
}
