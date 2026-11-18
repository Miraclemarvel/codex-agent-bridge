import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AntigravityConfig } from "../config.js";
import { agyModelSchema } from "../models-domain.js";
import {
  BridgeError,
  requireThat,
  type Attempt,
  type Contract,
  type Execution,
} from "../domain.js";
import type { AgentAdapter } from "./hermes.js";

const maxLineBytes = 4 * 1024 * 1024;
const systemEnv = [
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERNAME",
  "USER",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "PROCESSOR_ARCHITECTURE",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "LANG",
];

type Job = {
  child: ChildProcess;
  status: Execution;
  ended: Promise<void>;
  sessionId?: string;
  progress?: Record<string, unknown>;
  result?: { status: string; response: string };
  failure?: string;
};

export class AntigravityAdapter implements AgentAdapter {
  private jobs = new Map<string, Job>();

  constructor(readonly config: AntigravityConfig) {}

  async capabilities() {
    const { command, cwd } = this.config;
    requireThat(
      isAbsolute(command) &&
        !/\.(bat|cmd)$/i.test(command) &&
        statSync(command, { throwIfNoEntry: false })?.isFile() &&
        statSync(cwd, { throwIfNoEntry: false })?.isDirectory(),
      "INVALID_LAUNCH",
      "Antigravity needs the path to the agy executable and an existing workspace directory",
    );
    return {
      transport: "agy_stream_json",
      workspace: cwd,
      probe: "Launch paths only. Sign-in is checked during execution.",
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
      input: [
        "Execute the delegated task in this working directory. Follow its scope.",
        "In your final response, give relative paths to the actual deliverables, reproducible preview steps, checks run, and limitations.",
        JSON.stringify({
          task: contract,
          attempt: attempt.number,
          ...(attempt.feedback ? { reworkFeedback: attempt.feedback } : {}),
        }),
      ].join("\n"),
      timeoutSeconds: contract.timeoutSeconds,
      ...(attempt.agySelection ? { agySelection: attempt.agySelection } : {}),
    };
  }

  async submit(body: Record<string, unknown>, key: string) {
    if (this.jobs.has(key)) return key;
    await this.capabilities();
    const selection = agyModelSchema.parse(body.agySelection ?? {});
    const routeArgs = [
      ...(selection.model ? [`--model=${selection.model}`] : []),
      ...(selection.reasoningEffort
        ? [`--effort=${selection.reasoningEffort}`]
        : []),
    ];
    const replacedFlags = new Set(routeArgs.map((arg) => arg.split("=")[0]));
    const configArgs = this.config.args.filter(
      (arg, index, args) =>
        !replacedFlags.has(arg.split("=")[0]) &&
        !replacedFlags.has(args[index - 1]),
    );
    const env: NodeJS.ProcessEnv = {};
    for (const name of [...systemEnv, ...this.config.inheritEnv]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    const child = spawn(
      this.config.command,
      [
        ...configArgs,
        ...routeArgs,
        "--print=",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--print-timeout",
        `${body.timeoutSeconds}s`,
      ],
      {
        cwd: this.config.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
      },
    );
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job: Job = { child, status: "running", ended };
    this.jobs.set(key, job);
    let buffer = "";
    let diagnostic = "";
    const consume = (line: string) => {
      if (!line.trim() || job.failure) return;
      const parsed = streamEvent(line);
      if (!parsed) {
        job.failure = "INVALID_EVENT_STREAM";
        return;
      }
      if (parsed.event === "init" && typeof parsed.conversation_id === "string")
        job.sessionId = parsed.conversation_id;
      if (parsed.event === "step_update" && parsed.step_update) {
        const step = parsed.step_update;
        job.progress = {
          type: "step_update",
          step:
            typeof step.step_index === "number" ? step.step_index : undefined,
          phase: shortLabel(step.step_type),
          state: shortLabel(step.state),
        };
      }
      if (parsed.event === "result") {
        const result = parsed.result;
        if (job.result || !result || typeof result.status !== "string") {
          job.failure = "INVALID_RESULT";
          return;
        }
        const response =
          typeof result.response === "string" ? result.response : "";
        job.result = { status: result.status, response };
        if (
          result.status === "ERROR" &&
          typeof result.error === "string" &&
          /^invalid model selection\b/i.test(result.error)
        )
          job.failure = "AGY_INVALID_MODEL_SELECTION";
        if (typeof result.conversation_id === "string")
          job.sessionId = result.conversation_id;
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (job.failure) return;
      const lines = (buffer + chunk).split("\n");
      buffer = lines.pop()!;
      for (const line of lines) consume(line);
      if (Buffer.byteLength(buffer) > maxLineBytes) {
        buffer = "";
        job.failure = "EVENT_TOO_LARGE";
      }
    });
    // Keep raw diagnostics, internal steps and tool output out of the task store.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      diagnostic = (diagnostic + chunk).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      job.failure = "AGY_LAUNCH_FAILED";
    });
    child.on("close", (code) => {
      consume(buffer);
      if (job.status === "stopping" || job.result?.status === "CANCELED")
        job.status = "cancelled";
      else if (
        code === 0 &&
        !job.failure &&
        job.result?.status === "SUCCESS" &&
        job.result.response.trim()
      )
        job.status = "completed";
      else if (job.result?.status === "INTERRUPTED") job.status = "interrupted";
      else {
        job.status = "failed";
        const resultStatus = shortLabel(job.result?.status);
        job.progress = {
          type: "error",
          reason:
            /authentication required|not authenticated|please log in|sign.in required/i.test(
              diagnostic,
            )
              ? "AGY_AUTH_REQUIRED"
              : (job.failure ??
                (resultStatus === "SUCCESS"
                  ? code === 0
                    ? "AGY_EMPTY_RESPONSE"
                    : "AGY_NONZERO_EXIT"
                  : resultStatus) ??
                "AGY_NO_RESULT"),
          exitCode: code,
        };
      }
      finish();
    });
    child.stdin.end(
      JSON.stringify({
        event: "user",
        message: { content: String(body.input) },
      }) + "\n",
    );
    return key;
  }

  async status(key: string) {
    const job = this.jobs.get(key);
    if (!job) return { status: "unknown" };
    return {
      status: job.status,
      session_id: job.sessionId,
      progress: job.progress,
      output: job.status === "completed" ? job.result?.response : undefined,
    };
  }

  async stop(key: string) {
    const job = this.jobs.get(key);
    requireThat(
      job,
      "UNKNOWN_EXECUTION",
      "This process does not own the Antigravity execution",
    );
    if (job.status !== "running" && job.status !== "stopping") return;
    job.status = "stopping";
    const pid = job.child.pid;
    if (!pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      await new Promise<void>((resolve) => {
        killer.once("error", () => resolve());
        killer.once("close", () => resolve());
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {}
    }
    await Promise.race([job.ended, delay(1500, undefined, { ref: false })]);
    if (job.child.exitCode === null && job.child.signalCode === null) {
      if (process.platform === "win32") job.child.kill();
      else {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {}
      }
    }
  }

  async respond() {
    throw new BridgeError(
      "UNSUPPORTED_CONTROL",
      "Antigravity headless mode uses CLI permissions for tool approvals",
    );
  }

  async close() {
    await Promise.allSettled(
      [...this.jobs.keys()].map((key) => this.stop(key)),
    );
  }
}

function shortLabel(value: unknown) {
  return typeof value === "string" && /^[\w-]{1,64}$/.test(value)
    ? value
    : undefined;
}

function streamEvent(line: string) {
  if (Buffer.byteLength(line) > maxLineBytes) return;
  try {
    const event = JSON.parse(line);
    if (event && typeof event.event === "string")
      return event as {
        event: string;
        conversation_id?: unknown;
        step_update?: {
          step_index?: unknown;
          step_type?: unknown;
          state?: unknown;
        };
        result?: {
          status?: unknown;
          response?: unknown;
          conversation_id?: unknown;
          error?: unknown;
        };
      };
  } catch {}
}
