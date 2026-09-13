/**
 * Autoresearch contracts shared across the host: SSE events, snapshots, tool
 * params/outcomes, and the per-session runtime shape. Pure types + constants —
 * no runtime dependencies beyond the domain model.
 */

import type { ExperimentState } from "../domain/model";
import type { DetectedSession, RunningExperiment } from "../../shared/wire";

// Wire shapes (events, snapshots, detect) live in src/shared/wire.ts and are
// re-exported here — one definition, typechecker-shared with the client.
export type {
  AutoResearchEvent,
  DetectedSession,
  DetectResult,
  ExperimentSnapshot,
  RunningExperiment,
} from "../../shared/wire";

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

// DetectedSession/DetectResult come from the wire contract (re-exported above).