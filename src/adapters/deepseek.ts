import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { stringify } from "yaml";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { DeepSeekConfig } from "../config.js";
import {
  BridgeError,
  requireThat,
  type Attempt,
  type Contract,
} from "../domain.js";
import type { AgentAdapter } from "./hermes.js";
type Job = {
  child: ChildProcessWithoutNullStreams;
  state: string;
  output?: string;
  final?: string;
  failed: boolean;
  sessionId?: string;
  progress?: Record<string, unknown>;
  buffer: string;
  ended: Promise<void>;
};

/** Supported dsh headless --json transport (verified against installed 0.2.1-rc.3 docs).
 * One owned process per attempt; stdin carries the task, never a shell interpolation.
 * Exit code AND final frame are needed. An idle notification is not completion.
 */
export class DeepSeekAdapter implements AgentAdapter {
  private jobs = new Map<string, Job>();
  constructor(
    readonly config: DeepSeekConfig,
    private overlayDir?: string,
  ) {}
  async capabilities() {
    requireThat(
      isAbsolute(this.config.command) &&
        existsSync(this.config.command) &&
        existsSync(this.config.cwd),
      "INVALID_LAUNCH",
      "DeepSeek command/cwd must exist and command must be absolute",
    );
    requireThat(
      !/\.(cmd|bat)$/i.test(this.config.command),
      "INVALID_LAUNCH",
      "Use an executable and argv, not a shell wrapper",
    );
    return {
      transport: "headless_json",
      probe: "launch paths only; model access is verified by execution",
      features: {
        run_submission: true,
        run_status: true,
        run_stop: true,
        run_events_sse: false,
        run_approval: false,
        runs_idempotency: { supported: false, durable: false },
      },
    };
  }
  request(contract: Contract, attempt: Attempt) {
    return {
      ...(attempt.modelBinding?.selection
        ? { modelSelection: attempt.modelBinding.selection }
        : {}),
      input: JSON.stringify({
        task: contract,
        attempt: attempt.number,
        ...(attempt.feedback ? { reworkFeedback: attempt.feedback } : {}),
      }),
    };
  }
  async submit(body: Record<string, unknown>, key: string) {
    if (this.jobs.has(key)) return key;
    await this.capabilities();
    const env: Record<string, string> = {};
    for (const k of [
      "PATH",
      "Path",
      "SystemRoot",
      "WINDIR",
      "TEMP",
      "TMP",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      ...this.config.inheritEnv,
    ])
      if (process.env[k] !== undefined) env[k] = process.env[k]!;
    Object.assign(env, this.config.env);
    const args = [...this.config.args];
    if (body.modelSelection) {
      requireThat(
        this.overlayDir && /^[\w-]{1,80}$/.test(key),
        "INVALID_LAUNCH",
        "A safe overlay directory and attempt identity are required",
      );
      const s =
        body.modelSelection as import("../models-domain.js").ModelSelection;
      const patch = stringify([
        {
          id: "agent-default-model",
          config: {
            provider: s.provider,
            model: s.model,
            ...(s.reasoningEffort
              ? { reasoningEffort: s.reasoningEffort }
              : {}),
          },
        },
        ...(s.credentialRef
          ? [
              {
                id: "llm-pi-ai",
                config: {
                  providers: { [s.provider]: { apiKeyEnv: s.credentialRef } },
                },
              },
            ]
          : []),
      ]);
      mkdirSync(this.overlayDir, { recursive: true });
      const path = join(this.overlayDir, key + ".yml");
      if (existsSync(path))
        requireThat(
          readFileSync(path, "utf8") === patch,
          "CONFIG_CONFLICT",
          "An immutable model overlay already exists with different contents",
        );
      else writeFileSync(path, patch, { flag: "wx" });
      const index = args.indexOf("--json");
      args.splice(index < 0 ? args.length : index, 0, "--patch", path);
    }
    const child = spawn(this.config.command, args, {
      cwd: this.config.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let resolveEnd!: () => void;
    const ended = new Promise<void>((r) => {
      resolveEnd = r;
    });
    const job: Job = {
      child,
      state: "running",
      failed: false,
      buffer: "",
      ended,
    };
    this.jobs.set(key, job);
    const fail = () => {
      job.failed = true;
      void this.stop(key).catch(() => {});
    };
    const handle = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        fail();
        return;
      }
      if (event.type === "final") {
        if (typeof event.text !== "string") {
          fail();
          return;
        }
        job.final = event.text;
      }
      if (event.type === "session" && typeof event.sessionId === "string")
        job.sessionId = event.sessionId;
      if (event.type === "error") job.failed = true;
      if (event.type === "status") {
        job.progress = {
          type: "status",
          phase: event.phase,
          turn: event.turn,
          step: event.step,
        };
        if (event.phase === "turn_end" && event.reason?.kind !== "completed")
          job.failed = true;
      }
      if (event.type === "tool_call" || event.type === "tool_result")
        job.progress = { type: event.type };
      // Private reasoning and intermediate text are deliberately not stored in controller state.
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      job.buffer += chunk;
      if (Buffer.byteLength(job.buffer) > 4 * 1024 * 1024) {
        job.buffer = "";
        fail();
        return;
      }
      for (;;) {
        const end = job.buffer.indexOf("\n");
        if (end < 0) break;
        const line = job.buffer.slice(0, end);
        job.buffer = job.buffer.slice(end + 1);
        handle(line);
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => {
      job.failed = true;
      job.state = "failed";
    });
    child.on("close", (code) => {
      if (job.buffer.trim()) handle(job.buffer);
      job.buffer = "";
      job.state =
        job.state === "stopping" && !job.failed
          ? "cancelled"
          : code === 0 && !job.failed && job.final !== undefined
            ? "completed"
            : "failed";
      job.output = job.final;
      resolveEnd();
    });
    await Promise.race([
      once(child, "spawn"),
      once(child, "error").then(() => {
        throw new Error("DeepSeek failed to launch");
      }),
    ]);
    child.stdin.end(String(body.input));
    return key;
  }
  async status(id: string) {
    const j = this.jobs.get(id);
    if (!j) return { status: "unknown" };
    return {
      status: j.state,
      output: j.output,
      session_id: j.sessionId,
      progress: j.progress,
    };
  }
  async stop(id: string) {
    const j = this.jobs.get(id);
    requireThat(
      j,
      "UNKNOWN_EXECUTION",
      "This process does not own the DeepSeek execution",
    );
    if (["completed", "failed", "cancelled"].includes(j.state)) return;
    j.state = "stopping";
    const pid = j.child.pid;
    if (pid) {
      if (process.platform === "win32") {
        const killer = spawn(
          "taskkill.exe",
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore" },
        );
        await new Promise<void>((resolve) => {
          killer.once("error", () => resolve());
          killer.once("close", () => resolve());
        });
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {}
      }
      await Promise.race([j.ended, delay(1500)]);
      if (j.child.exitCode === null && j.child.signalCode === null) {
        if (process.platform !== "win32")
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        else j.child.kill();
      }
    }
  }
  async respond() {
    throw new BridgeError(
      "UNSUPPORTED_CONTROL",
      "Headless DeepSeek does not expose interactive controls; stop and rework with clarified input",
    );
  }
  async close() {
    await Promise.allSettled([...this.jobs.keys()].map((id) => this.stop(id)));
  }
}
