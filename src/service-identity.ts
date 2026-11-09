import { sha256 } from "./artifacts.js";
import type { Config } from "./config.js";
export const APP_VERSION = "0.3.1";
export const SERVICE_NAME = "codex-agent-bridge";
export const serviceIdentity = (config: Config) =>
  sha256(JSON.stringify(config));
