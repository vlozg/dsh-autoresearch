/**
 * .auto/hooks/{before,after}.sh — optional user hooks fired around the loop
 * (port of pi-autoresearch hooks.ts). stdout becomes steer text: in DSH it is
 * appended to the tool result that triggered the stage.
 */

import { spawn } from "node:child_process";
import type { RunEntry } from "./jsonl";
import { hookScriptPath } from "./paths";
import { truncateAtBoundary } from "./truncate";

const HOOK_TIMEOUT_MS = 30_000;
const HOOK_MAX_BYTES = 8 * 1024;

export interface SessionSnapshot {
  metric_name: string;
  metric_unit: string;
  direction: "lower" | "higher";
  baseline_metric: number | null;
  best_metric: number | null;
  run_count: number;
  goal?: string;
  workDir?: string;
}

export interface HookPayload {
  event: "before" | "after";
  cwd: string;
  /** before only */
  next_run?: number;
  last_run?: Record<string, unknown>;
  /** after only */
  run_entry?: Record<string, unknown>;
  session: SessionSnapshot;
}

/** Run one hook stage; returns stdout (truncated) as steer text, or null. */
export function fireHook(payload: HookPayload): Promise<string | null> {
  const script = hookScriptPath(payload.cwd, payload.event);
  return new Promise((resolve) => {
    try {
      if (!require("node:fs").existsSync(script)) {
        resolve(null);
        return;
      }
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const child = spawn("bash", [script], {
      cwd: payload.cwd,
      timeout: HOOK_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolve(`[hook ${payload.event} timed out after 30s]`);
      }
    }, HOOK_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const trimmed = truncateAtBoundary(stdout, HOOK_MAX_BYTES).trim();
      if (code !== 0 || trimmed !== "") {
        resolve(trimmed !== ""
          ? trimmed
          : `[hook ${payload.event} exited ${code}] ${truncateAtBoundary(stderr, 500)}`);
      } else {
        resolve(null);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve(`[hook ${payload.event} failed to spawn: ${err.message}]`);
      }
    });

    // Feed the payload on stdin, then close.
    try {
      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    } catch {
      // stdin failures are non-fatal.
    }
  });
}

/** Re-export for tools that want the raw entry type. */
export type { RunEntry };
