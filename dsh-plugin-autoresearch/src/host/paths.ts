/**
 * Session file path resolution (port of pi-autoresearch paths.ts).
 *
 * All autoresearch session files live under a single `.auto/` subfolder at the
 * workdir root (one folder to preserve across reverts, gitignore, and cleanup).
 * The legacy flat `autoresearch.*` layout is not created by new sessions; it is
 * only read when present and no current-layout artifact exists.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const AUTO_DIR = ".auto";

export type SessionFileKind = "log" | "prompt" | "ideas" | "checks" | "measure" | "config";

const SESSION_FILE_NAMES: Record<SessionFileKind, string> = {
  log: "log.jsonl",
  prompt: "prompt.md",
  ideas: "ideas.md",
  checks: "checks.sh",
  measure: "measure.sh",
  config: "config.json",
};

export function autoDir(dir: string): string {
  return path.join(dir, AUTO_DIR);
}

export function sessionFilePath(dir: string, kind: SessionFileKind): string {
  return path.join(dir, AUTO_DIR, SESSION_FILE_NAMES[kind]);
}

export function hookScriptPath(workDir: string, stage: "before" | "after"): string {
  return path.join(workDir, AUTO_DIR, "hooks", `${stage}.sh`);
}

export function runsDir(workDir: string): string {
  return path.join(workDir, AUTO_DIR, "runs");
}

export function runLogPath(workDir: string, run: number): string {
  return path.join(runsDir(workDir), `${run}.log`);
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function canonicalPath(existingPath: string): string {
  try {
    return fs.realpathSync.native(existingPath);
  } catch {
    return path.resolve(existingPath);
  }
}

export function samePath(a: string, b: string): boolean {
  return canonicalPath(a) === canonicalPath(b);
}

/**
 * Validate that the resolved working directory exists and is a directory.
 * Returns an error message when invalid, or null when OK.
 */
export function validateWorkDir(workDir: string): string | null {
  try {
    const stat = fs.statSync(workDir);
    if (!stat.isDirectory()) {
      return `workingDir "${workDir}" is not a directory.`;
    }
  } catch {
    return `workingDir "${workDir}" does not exist.`;
  }
  return null;
}

/**
 * Read `.auto/config.json` (pi compatibility: optional maxIterations /
 * workingDir overrides). Returns {} when missing or unparsable.
 */
export function readConfig(workDir: string): { maxIterations?: number; workingDir?: string } {
  try {
    const raw = fs.readFileSync(sessionFilePath(workDir, "config"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: { maxIterations?: number; workingDir?: string } = {};
    if (typeof parsed.maxIterations === "number" && parsed.maxIterations > 0) {
      out.maxIterations = Math.floor(parsed.maxIterations);
    }
    if (typeof parsed.workingDir === "string") out.workingDir = parsed.workingDir;
    return out;
  } catch {
    return {};
  }
}

/**
 * Resolve the effective working directory: `.auto/config.json` workingDir
 * (relative paths resolved against the session cwd) wins, else session cwd.
 */
export function resolveWorkDir(sessionCwd: string): string {
  const config = readConfig(sessionCwd);
  if (!config.workingDir) return sessionCwd;
  return path.isAbsolute(config.workingDir)
    ? config.workingDir
    : path.resolve(sessionCwd, config.workingDir);
}
