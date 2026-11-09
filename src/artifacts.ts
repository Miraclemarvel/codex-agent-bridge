import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { type Snapshot, now, requireThat } from "./domain.js";
export const sha256 = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
export function snapshot(output: unknown): Snapshot {
  const text =
    typeof output === "string" ? output : JSON.stringify(output ?? "");
  const artifacts = [
    {
      name: "agent-report.txt",
      text,
      sha256: sha256(text),
      source: "agent_report" as const,
    },
  ];
  return {
    digest: sha256(
      JSON.stringify(artifacts.map(({ name, sha256 }) => ({ name, sha256 }))),
    ),
    artifacts,
    createdAt: now(),
  };
}

export function captureFiles(
  previous: Snapshot,
  paths: string[],
  roots: string[],
): Snapshot {
  requireThat(
    roots.length > 0,
    "NO_ARTIFACT_ROOTS",
    "Configure artifactRoots before capturing files",
  );
  requireThat(
    paths.length > 0 && paths.length <= 16,
    "ARTIFACT_LIMIT",
    "Capture 1–16 files per delivery",
  );
  const allowed = roots.map((p) => realpathSync(p));
  const files = paths.map((p) => realpathSync(p));
  requireThat(
    new Set(files).size === files.length,
    "DUPLICATE_FILE",
    "Duplicate file paths",
  );
  const artifacts = previous.artifacts.filter(
    (a) => a.source === "agent_report",
  );
  let total = 0;
  for (const file of files) {
    const root = allowed.find((r) => {
      const rel = relative(r, file);
      return (
        rel !== "" &&
        rel !== ".." &&
        !rel.startsWith("..\\") &&
        !rel.startsWith("../") &&
        !isAbsolute(rel)
      );
    });
    requireThat(
      root,
      "PATH_OUTSIDE_ROOT",
      "Artifact path is outside configured roots (including symlink targets)",
    );
    const stat = statSync(file);
    requireThat(
      stat.isFile() && stat.size <= 1024 * 1024,
      "ARTIFACT_LIMIT",
      "Only regular files up to 1 MiB can be captured",
    );
    const bytes = readFileSync(file);
    total += bytes.length;
    requireThat(
      bytes.length <= 1024 * 1024 && total <= 4 * 1024 * 1024,
      "ARTIFACT_LIMIT",
      "Delivery file content exceeds size limit",
    );
    artifacts.push({
      name: `local/${allowed.indexOf(root)}/${relative(root, file).replaceAll("\\", "/")}`,
      text: bytes.toString("base64"),
      encoding: "base64",
      sha256: sha256(bytes),
      source: "local_file",
      sourcePath: file,
    });
  }
  return {
    artifacts,
    digest: sha256(
      JSON.stringify(
        artifacts.map((a) => ({
          name: a.name,
          sha256: a.sha256,
          sourcePath: a.sourcePath,
        })),
      ),
    ),
    createdAt: now(),
  };
}
export function filesCurrent(snapshot: Snapshot): boolean {
  return snapshot.artifacts.every((a) => {
    if (a.source !== "local_file") return true;
    try {
      return (
        realpathSync(a.sourcePath!) === a.sourcePath &&
        statSync(a.sourcePath!).size <= 1024 * 1024 &&
        sha256(readFileSync(a.sourcePath!)) === a.sha256
      );
    } catch {
      return false;
    }
  });
}
