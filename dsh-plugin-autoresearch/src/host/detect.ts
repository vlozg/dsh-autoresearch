/**
 * Past-session detection: scan candidate workdirs for an existing `.auto/`
 * contract (created by this plugin or by pi-autoresearch) and summarize each
 * hit from `.auto/log.jsonl`. The scan is shallow and dependency-aware — it
 * never descends into `.auto/` itself, hidden dirs, or dependency/build
 * folders, so it is safe to run on demand from the dashboard.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sessionFilePath } from "./adapters/fs-log-store";
import { reconstructState } from "./adapters/jsonl";

/** One discovered (past or live) autoresearch session. */
export interface DetectedSession {
  /** Live agent/session id when the workdir belongs to an open conversation. */
  sessionId: string | null;
  workDir: string;
  name: string;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  metricLabel: string | null;
  objectiveLabel: string | null;
  currentSegment: number;
  runs: number;
  bestMetric: number | null;
  lastTimestamp: number | null;
}

export interface DetectResult {
  /** Workdirs now attached to a live conversation (cards appear via SSE). */
  attached: DetectedSession[];
  /** Past sessions with no live conversation in their workdir. */
  unattached: DetectedSession[];
}

/** How deep below a scan root the `.auto/` hunt descends. */
export const SCAN_DEPTH = 2;

/** Directories the scan never enters (dependency / build / VCS noise). */
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".cache", ".pnpm-store", ".venv", "venv",
  "dist", "build", "out", "target", ".next", ".turbo", ".nuxt",
  "coverage", "__pycache__", ".gradle", ".idea", ".vscode",
]);

function* walkWorkdirs(root: string, depth: number): Generator<string> {
  yield root;
  if (depth <= 0) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    yield* walkWorkdirs(path.join(root, entry.name), depth - 1);
  }
}

/**
 * All directories under `root` (inclusive, `SCAN_DEPTH` deep) that contain
 * `.auto/log.jsonl`. Symlinks and hidden/dependency directories are skipped.
 */
export function findAutoWorkdirs(root: string, depth: number = SCAN_DEPTH): string[] {
  const found: string[] = [];
  for (const dir of walkWorkdirs(root, depth)) {
    try {
      if (fs.existsSync(sessionFilePath(dir, "log"))) found.push(dir);
    } catch {
      // Unreadable candidate: skip it.
    }
  }
  return found;
}

/**
 * Summarize one workdir's `.auto/log.jsonl` (pi files included — the JSONL
 * schema is shared). Returns null when the file is missing/unreadable or
 * holds neither a config header nor any run (an empty, never-used `.auto/`).
 */
export function summarizeWorkdir(workDir: string): DetectedSession | null {
  let content: string;
  try {
    content = fs.readFileSync(sessionFilePath(workDir, "log"), "utf-8");
  } catch {
    return null;
  }
  const state = reconstructState(content);
  if (state.name === null && state.results.length === 0) return null;
  let best: number | null = null;
  for (const run of state.results) {
    if (run.metric <= 0 || !Number.isFinite(run.metric)) continue;
    if (best === null) {
      best = run.metric;
      continue;
    }
    const better = state.bestDirection === "lower" ? run.metric < best : run.metric > best;
    if (better) best = run.metric;
  }
  const last = state.results.length > 0 ? state.results[state.results.length - 1] : undefined;
  return {
    sessionId: null,
    workDir,
    name: state.name ?? "Autoresearch",
    metricName: state.metricName,
    metricUnit: state.metricUnit,
    bestDirection: state.bestDirection,
    metricLabel: state.metricLabel,
    objectiveLabel: state.objectiveLabel,
    currentSegment: state.currentSegment,
    runs: state.results.length,
    bestMetric: best,
    lastTimestamp: last !== undefined ? last.timestamp : null,
  };
}

/** Newest activity first; sessions without runs sort last. */
export function byRecency(a: DetectedSession, b: DetectedSession): number {
  return (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0);
}
