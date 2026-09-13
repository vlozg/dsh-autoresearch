/**
 * Autoresearch contracts shared across the host: SSE events, snapshots, tool
 * params/outcomes, and the per-session runtime shape. Pure types + constants —
 * no runtime dependencies beyond the domain model.
 */

import type { ExperimentState, MetricDef, RunEntry } from "./domain/model";

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
  state: ExperimentState;
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

export interface PluginConfig {
  defaultExperimentTimeoutSeconds: number;
  defaultChecksTimeoutSeconds: number;
  /** Turn off pi's same-cwd auto-activation (log exists + same cwd → loop on). */
  autoActivateLoop: boolean;
}
