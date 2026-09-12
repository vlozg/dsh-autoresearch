/**
 * Git bookkeeping for experiment results (port of pi-autoresearch).
 * keep → commit everything (with a structured Result trailer); discard /
 * crash / checks_failed → revert the working tree while preserving `.auto/`
 * and legacy autoresearch files.
 */

import { execFile } from "node:child_process";

export const AUTO_DIR = ".auto";

/** Exact exclude globs from pi's revert script. */
const REVERT_EXCLUDE_GLOBS = [
  `(exclude,glob)**/${AUTO_DIR}`,
  `(exclude,glob)**/${AUTO_DIR}/**`,
  "(exclude,glob)**/autoresearch.*",
  "(exclude,glob)**/autoresearch.*/**",
];

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

function gitExec(workDir: string, args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: workDir, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error && typeof (error as { code?: number }).code === "number"
            ? (error as { code: number }).code
            : error ? -1 : 0,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          error: error === null ? undefined : error.message,
        });
      },
    );
  });
}

function output(r: ExecResult): string {
  return (r.stdout + r.stderr).trim();
}

export interface KeepResult {
  committed: boolean;
  sha?: string;
  message?: string;
}

/**
 * `git add -A`, then commit only when the tree actually changed. Message:
 * `<description>\n\nResult: <json>` (pi parity). Never rewrites the model's
 * git identity beyond the minimal author fallback DSH environments need.
 */
export async function gitAutoCommit(
  workDir: string,
  description: string,
  resultData: Record<string, unknown>,
): Promise<KeepResult> {
  const add = await gitExec(workDir, ["add", "-A"], 10_000);
  if (add.code !== 0) {
    return { committed: false, message: `git add failed (exit ${add.code}): ${output(add).slice(0, 200)}` };
  }

  const staged = await gitExec(workDir, ["diff", "--cached", "--quiet"], 10_000);
  if (staged.code === 0) {
    return { committed: false, message: "nothing to commit (working tree clean)" };
  }

  const trailerJson = JSON.stringify(resultData);
  const commitMsg = `${description}\n\nResult: ${trailerJson}`;
  const commit = await gitExec(
    workDir,
    ["-c", "user.name=dsh-autoresearch", "-c", "user.email=autoresearch@localhost", "commit", "-m", commitMsg],
    30_000,
  );
  if (commit.code !== 0) {
    return { committed: false, message: `git commit failed (exit ${commit.code}): ${output(commit).slice(0, 200)}` };
  }

  const sha = await gitExec(workDir, ["rev-parse", "--short=7", "HEAD"], 5000);
  const short = (sha.stdout || "").trim();
  return { committed: true, sha: short.length >= 7 ? short : undefined, message: output(commit).split("\n")[0] };
}

/** Revert working-tree changes, excluding autoresearch session files (pi globs). */
export async function gitRevert(workDir: string): Promise<{ ok: boolean; message?: string }> {
  const script = [
    `git checkout -- . ${REVERT_EXCLUDE_GLOBS.map((g) => `':${g}'`).join(" ")}`,
    `git clean -fd -e '${AUTO_DIR}' -e '**/${AUTO_DIR}/**' -e 'autoresearch.*' -e '**/autoresearch.*/**' 2>/dev/null`,
  ].join("\n");

  return new Promise((resolve) => {
    execFile("bash", ["-c", script], { cwd: workDir, timeout: 10_000 }, (error) => {
      resolve({ ok: error === null, message: error === null ? undefined : error.message });
    });
  });
}

/** Short HEAD hash for display; null outside a git repo. */
export async function gitCurrentCommit(workDir: string): Promise<string | null> {
  const r = await gitExec(workDir, ["rev-parse", "--short=7", "HEAD"], 5000);
  return r.code === 0 ? (r.stdout || "").trim() || null : null;
}
