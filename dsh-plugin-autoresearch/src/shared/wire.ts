/**
 * Host↔client wire contract — the shapes that cross JSON boundaries
 * (SSE events, snapshots, the detect scan). Pure types, no imports, no
 * runtime code: both faces `import type` from here, so the typechecker
 * owns the contract and drift fails the build, not the dashboard.
 *
 * RunEntry/MetricDef are defined here rather than re-exported from the
 * host domain model: the .auto/log.jsonl byte format must survive
 * persistence-adapter swaps (see src/host/domain/model.ts), while these
 * wire shapes only need to survive JSON.stringify — a structural
 * mismatch still fails the build at the snapshot assignment in
 * experiment-service.
 */

/** One logged run — the .auto/log.jsonl entry schema. */
export interface RunEntry {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  title?: string;
  summary?: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
  asi?: Record<string, unknown>;
}

/** A secondary metric definition (name + inferred display unit). */
export interface MetricDef {
  name: string;
  unit: string;
}

/** The live run while an experiment is in flight. */
export interface RunningExperiment {
  command: string;
  startedAt: number;
  phase: "running" | "checks";
}

/** JSON.stringify(ExperimentState) plus the runtime loop/running fields. */
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

/** SSE wire events: named `state` / `running` on /autoresearch/events. */
export type AutoResearchEvent =
  | { kind: "state"; sessionId: string; snapshot: ExperimentSnapshot }
  | { kind: "running"; sessionId: string; running: RunningExperiment; tail?: string };

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

/** GET /autoresearch/detect — workdirs matching open conversations. */
export interface DetectResult {
  /** Workdirs now attached to a live conversation (cards arrive via SSE). */
  attached: DetectedSession[];
  /** Past sessions with no live conversation in their workdir. */
  unattached: DetectedSession[];
}
