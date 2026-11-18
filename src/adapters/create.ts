import type { AgentConfig } from "../config.js";
import { AntigravityAdapter } from "./antigravity.js";
import { DeepSeekAdapter } from "./deepseek.js";
import { HermesAdapter, type AgentAdapter } from "./hermes.js";

export function createAdapter(
  config: AgentConfig,
  timeoutMs: number,
  overlayDir?: string,
): AgentAdapter {
  switch (config.kind) {
    case "hermes":
      return new HermesAdapter(config, timeoutMs);
    case "deepseek":
      return new DeepSeekAdapter(config, overlayDir);
    case "antigravity":
      return new AntigravityAdapter(config);
  }
}
