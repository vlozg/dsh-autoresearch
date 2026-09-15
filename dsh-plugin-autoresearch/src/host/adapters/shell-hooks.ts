/**
 * .auto/hooks/{before,after}.sh — optional user hooks fired around the loop
 * (port of pi-autoresearch hooks.ts). stdout becomes steer text: in DSH it is
 * appended to the tool result that triggered the stage.
 */

import { spawn } from "node:child_process";
import { hookScriptPath } from "./fs-log-store";
import { truncateAtBoundary } from "../app/truncate";
import type { HookPayload, HookRunner, SessionSnapshot } from "../app/ports";

const HOOK_TIMEOUT_MS = 30_000;
const HOOK_MAX_BYTES = 8 * 1024;


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


/** Node spawn implementation of the HookRunner port. */
export const shellHooks: HookRunner = { fire: fireHook };