/**
 * Autoresearch contracts shared across the host: SSE events, snapshots, tool
 * params/outcomes, the per-session runtime shape, and auto-resume limits.
 * Pure types + constants — no runtime dependencies beyond jsonl/metrics.
 */

import { reconstructState, type RunEntry, type MetricDef } from "./jsonl";
import { countConsecutiveDiscardOrCrashResults } from "./metrics";

export type AutoResearchEvent =
  | { kind: "state"; sessionId: string; snapshot: ExperimentSnapshot }
  | { kind: "running"; sessionId: string; running: RunningExperiment; tail?: string };

export interface RunningExperiment {
  command: string;
  startedAt: number;
  phase: "running" | "checks";
}

export interface ExperimentSnapshot {
  sessionId: string;
  workDir: string;
  name: string;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  metricLabel: string | null;
  objectiveLabel: string | null;
  currentSegment: number;
  maxExperiments: number | null;
  baseline: number | null;
  bestMetric: number | null;
  confidence: number | null;
  runs: RunEntry[];
  secondaryMetrics: MetricDef[];
  running: RunningExperiment | null;
  loop: boolean;
  loopStopReason: string | null;
  experimentsThisSession: number;
  autoResumeTurns: number;
}

export interface InitParams {
  name: string;
  metric_name: string;
  metric_unit?: string;
  direction?: "lower" | "higher";
  metric_label?: string;
  objective_label?: string;
}

export interface RunParams {
  command: string;
  timeout_seconds?: number;
  checks_timeout_seconds?: number;
}

export interface LogParams {
  commit: string;
  metric: number;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  metrics?: Record<string, number>;
  force?: boolean;
  title?: string;
  summary?: string;
  asi?: Record<string, unknown>;
}

export interface ToolOutcome {
  text: string;
  value: Record<string, unknown>;
}

export interface SessionRuntime {
  sessionId: string;
  agentId: string;
  sessionCwd: string;
  workDir: string;
  /** Reconstructed from .auto/log.jsonl — mutated in place. */
  state: ReturnType<typeof reconstructState>;
  maxExperiments: number | null;
  running: RunningExperiment | null;
  runningAbort: AbortController | null;
  lastRunChecks: { pass: boolean; output: string; duration: number } | null;
  lastRunDuration: number | null;
  experimentsThisSession: number;
  /** Auto-resume mode (pi: autoresearchMode). */
  loop: boolean;
  loopStopReason: string | null;
  autoResumeTurns: number;
  lastTail: string | undefined;
}

export const AUTORESUME_TURN_LIMIT = 200;
export const CONSECUTIVE_FAILURE_OVERRIDE_LIMIT = 20;

/** Auto-resume stop decision, mirroring pi's autoResumeStopReasonFor. */
export function autoResumeStopReason(state: {
  autoResumeTurns: number;
  results: RunEntry[];
  currentSegment: number;
}): string | null {
  if (state.autoResumeTurns >= AUTORESUME_TURN_LIMIT) {
    return `Autoresearch auto-resume limit reached (${AUTORESUME_TURN_LIMIT} turns)`;
  }
  const failures = countConsecutiveDiscardOrCrashResults(state.results, state.currentSegment);
  if (failures > CONSECUTIVE_FAILURE_OVERRIDE_LIMIT) {
    return `Autoresearch auto-resume stopped — ${failures} consecutive discards/crashes`;
  }
  return null;
}

export interface PluginConfig {
  defaultExperimentTimeoutSeconds: number;
  defaultChecksTimeoutSeconds: number;
  /** Turn off pi's same-cwd auto-activation (log exists + same cwd → loop on). */
  autoActivateLoop: boolean;
}
