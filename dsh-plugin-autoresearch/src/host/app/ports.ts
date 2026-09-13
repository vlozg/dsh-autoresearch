/**
 * Ports — the interfaces the application core (ExperimentService and the
 * init/run/log use cases) needs from the outside world. Driven-side node
 * adapters under ../adapters implement them; the composition root in the
 * host entry wires the real implementations in. The core never imports
 * node builtins directly.
 */

import type { ExperimentState, JsonlEntry } from "../domain/model";
import type { DetectResult, DetectedSession } from "./contracts";

export type { DetectResult, DetectedSession };

export interface Clock {
  now(): number;
}

/** Session-relative file kinds of the `.auto/` contract. */
export type SessionFileKind = "log" | "prompt" | "ideas" | "checks" | "measure" | "config";

/**
 * Durable session storage: the `.auto/` directory layout, the JSONL event
 * log (source of truth), run logs, and workdir validation/resolution.
 */
export interface LogStore {
  /** Absolute path of a session file (adapter-defined layout). */
  sessionPath(workDir: string, kind: SessionFileKind): string;
  exists(workDir: string, kind: SessionFileKind): boolean;
  /** Raw log.jsonl content; null when missing or unreadable. */
  readLog(workDir: string): string | null;
  /** Rebuild state from log.jsonl; fresh state when the file is missing. */
  loadState(workDir: string): ExperimentState;
  /** Append one JSONL entry (newline included); reports write failures. */
  appendEntry(workDir: string, entry: JsonlEntry): { ok: true } | { ok: false; path: string; error: string };
  /** Persist one run's full output; returns the path, undefined when blank or failed. */
  writeRunLog(workDir: string, run: number, content: string): string | undefined;
  canonicalPath(existingPath: string): string;
  samePath(a: string, b: string): boolean;
  /** Error message when the directory is unusable, null when OK. */
  validateWorkDir(workDir: string): string | null;
  /** `.auto/config.json` workingDir override wins, else the session cwd. */
  resolveWorkDir(sessionCwd: string): string;
  readConfig(sessionCwd: string): { maxIterations?: number; workingDir?: string };
}

export interface KeepResult {
  committed: boolean;
  sha?: string;
  message?: string;
}

/** Git bookkeeping: commit on keep, revert on discard/crash/checks_failed. */
export interface GitVcs {
  autoCommit(workDir: string, description: string, resultData: Record<string, unknown>): Promise<KeepResult>;
  revert(workDir: string): Promise<{ ok: boolean; message?: string }>;
}

/** Truncated-tail view (structural twin of the truncate helper's result). */
export interface TailView {
  content: string;
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  outputLines: number;
  totalLines: number;
}

export interface RunCommandOptions {
  workDir: string;
  command: string;
  /** Wall-clock timeout in ms (0 = no timeout). */
  timeoutMs: number;
  maxLines: number;
  maxBytes: number;
  signal?: AbortSignal;
  /** 1s progress callback (tail snapshot + elapsed). */
  onUpdate?: (payload: { elapsedMs: number; tail: TailView; fullOutputPath?: string }) => void;
}

export interface TimedRunResult {
  exitCode: number | null;
  killed: boolean;
  /** Terminated because the caller's AbortSignal fired (not a timeout). */
  aborted: boolean;
  output: string;
  tempFilePath?: string;
  actualTotalBytes: number;
  durationSeconds: number;
}

export interface CommandRunner {
  run(options: RunCommandOptions): Promise<TimedRunResult>;
}

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

/** .auto/hooks/{before,after}.sh — stdout becomes steer text. */
export interface HookRunner {
  fire(payload: HookPayload): Promise<string | null>;
}

/** Past-session discovery: find `.auto/` workdirs and summarize each. */
export interface SessionScanner {
  findAutoWorkdirs(root: string, depth?: number): string[];
  summarize(workDir: string): DetectedSession | null;
}

/** Every driven capability the service composes. */
export interface ServiceDeps {
  clock: Clock;
  logStore: LogStore;
  git: GitVcs;
  runner: CommandRunner;
  hooks: HookRunner;
  scanner: SessionScanner;
}

// --- run output budgets (shared by the runner call and the result text) ---

export const DEFAULT_MAX_LINES = 40;
export const DEFAULT_MAX_BYTES = 32 * 1024; // 32KB display budget
export const LLM_MAX_LINES = 10;
export const LLM_MAX_BYTES = 4 * 1024; // 4KB context budget