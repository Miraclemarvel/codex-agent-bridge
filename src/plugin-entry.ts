import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, type Config } from "./config.js";
import {
  APP_VERSION,
  SERVICE_NAME,
  serviceIdentity,
} from "./service-identity.js";
import { requireThat } from "./domain.js";

export async function probeService(base: string, config: Config) {
  try {
    const r = await fetch(base + "/api/health", {
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    requireThat(
      r.ok,
      "PORT_IN_USE",
      "The configured port is occupied by an incompatible service",
    );
    const h = await r.json();
    requireThat(
      h.service === SERVICE_NAME &&
        h.identity === serviceIdentity(config) &&
        h.version === APP_VERSION,
      "SERVICE_MISMATCH",
      "A different or older Agent Bridge service owns this port; stop it before using this plugin",
    );
    return h as { pid: number; version: string; identity: string };
  } catch (e) {
    const cause = (e as any)?.cause;
    if (cause?.code === "ECONNREFUSED") return null;
    throw e;
  }
}
export async function ensureService(configFile: string) {
  const full = resolve(configFile),
    config = loadConfig(full),
    port = config.dashboard?.port ?? 4318;
  requireThat(
    port > 0,
    "INVALID_PORT",
    "The plugin requires a fixed dashboard port",
  );
  const base = `http://127.0.0.1:${port}`;
  const ready = await probeService(base, config);
  if (ready) return { base, ...ready, started: false };
  mkdirSync(config.dataDir, { recursive: true });
  const lock = join(config.dataDir, "service-start.lock");
  let acquired = false;
  const deadline = Date.now() + 30000;
  while (!acquired) {
    try {
      const fd = openSync(lock, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      acquired = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let owner = 0;
      try {
        owner = Number(readFileSync(lock, "utf8"));
      } catch {}
      if (owner > 0) {
        try {
          process.kill(owner, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") {
            try {
              unlinkSync(lock);
            } catch {}
            continue;
          }
        }
      }
      requireThat(
        Date.now() < deadline,
        "STARTUP_TIMEOUT",
        "Timed out waiting for Agent Bridge startup",
      );
      await delay(150);
      const health = await probeService(base, config);
      if (health) return { base, ...health, started: false };
    }
  }
  try {
    const health = await probeService(base, config);
    if (health) return { base, ...health, started: false };
    const log = openSync(join(config.dataDir, "service.log"), "a");
    const child = spawn(
      process.execPath,
      [join(dirname(fileURLToPath(import.meta.url)), "dashboard.js")],
      {
        cwd: dirname(full),
        env: { ...process.env, AGENT_BRIDGE_CONFIG: full },
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
      },
    );
    let launchFailed = false;
    child.once("error", () => {
      launchFailed = true;
    });
    child.unref();
    closeSync(log);
    while (Date.now() < deadline) {
      requireThat(
        !launchFailed,
        "START_FAILED",
        "Unable to start Agent Bridge",
      );
      await delay(150);
      const h = await probeService(base, config);
      if (h) return { base, ...h, started: true };
    }
    throw new Error("Agent Bridge did not become ready; inspect service.log");
  } finally {
    if (acquired)
      try {
        if (readFileSync(lock, "utf8") === String(process.pid))
          unlinkSync(lock);
      } catch {}
  }
}
async function main() {
  const service = await ensureService(
    process.env.AGENT_BRIDGE_CONFIG ?? "bridge.local.json",
  );
  const backend = new Client({
    name: "agent-bridge-plugin-session",
    version: APP_VERSION,
  });
  await backend.connect(
    new StreamableHTTPClientTransport(new URL(service.base + "/mcp")),
  );
  const server = new Server(
    { name: SERVICE_NAME, version: APP_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => backend.listTools());
  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => (await backend.callTool(request.params)) as any,
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await backend.close();
    await server.close();
  };
  process.stdin.once("end", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  await server.connect(new StdioServerTransport());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(
      "Agent Bridge plugin: " +
        (e instanceof Error ? e.message : "startup failed"),
    );
    process.exitCode = 1;
  });
