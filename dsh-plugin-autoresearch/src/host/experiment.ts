/**
 * ExperimentService — per-session autoresearch runtime over the `.auto/`
 * contract. Holds the reconstructed state (rebuilt from `.auto/log.jsonl` on
 * first touch — the file is the source of truth), the running-experiment
 * handle, loop mode, and the SSE publisher the client dashboard consumes.
 *
 * Module layout: contracts in ./experiment-types, tool operation bodies in
 * ./experiment-ops, past-session detection helpers in ./detect. The three
 * tools (tools.ts) delegate here; the auto-resume injector (resume.ts) reads
 * loop state and guards from here.
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  byRecency,
  findAutoWorkdirs,
  summarizeWorkdir,
  type DetectResult,
  type DetectedSession,
} from "./detect";
import { SCAN_DEPTH } from "./detect";
import {
  canonicalPath,
  ensureParentDir,
  readConfig,
  resolveWorkDir,
  samePath,
  sessionFilePath,
  validateWorkDir,
} from "./paths";
import { reconstructState } from "./jsonl";
import { bestMetric, computeConfidence, findBaselineMetric } from "./domain/metrics";
import { initExperimentOp, runExperimentOp, logExperimentOp } from "./experiment-ops";
import type {
  AutoResearchEvent,
  ExperimentSnapshot,
  InitParams,
  LogParams,
  PluginConfig,
  RunParams,
  SessionRuntime,
  ToolOutcome,
} from "./experiment-types";

export * from "./experiment-types";

export class ExperimentService {
  private runtimes = new Map<string, SessionRuntime>();
  private listeners = new Set<(event: AutoResearchEvent) => void>();

  constructor(
    private readonly ctx: Context,
    /** @internal */ readonly config: PluginConfig,
  ) {}

  subscribe(listener: (event: AutoResearchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @internal */ publish(event: AutoResearchEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One failing dashboard never breaks the loop.
      }
    }
  }

  /** @internal */ emitState(runtime: SessionRuntime): void {
    this.publish({ kind: "state", sessionId: runtime.sessionId, snapshot: this.snapshot(runtime) });
  }

  snapshot(runtime: SessionRuntime): ExperimentSnapshot {
    const s = runtime.state;
    return {
      sessionId: runtime.sessionId,
      workDir: runtime.workDir,
      name: s.name ?? "Autoresearch",
      metricName: s.metricName,
      metricUnit: s.metricUnit,
      bestDirection: s.bestDirection,
      metricLabel: s.metricLabel,
      objectiveLabel: s.objectiveLabel,
      currentSegment: s.currentSegment,
      maxExperiments: runtime.maxExperiments,
      baseline: findBaselineMetric(s.results, s.currentSegment),
      bestMetric: this.bestOf(s),
      confidence: computeConfidence(s.results, s.currentSegment, s.bestDirection),
      runs: [...s.results],
      secondaryMetrics: s.secondaryMetrics.map((m) => ({ ...m })),
      running: runtime.running,
      loop: runtime.loop,
      loopStopReason: runtime.loopStopReason,
      experimentsThisSession: runtime.experimentsThisSession,
      autoResumeTurns: runtime.autoResumeTurns,
    };
  }

  /** @internal */ bestOf(state: SessionRuntime["state"]): number | null {
    return bestMetric(state.results, state.currentSegment, state.bestDirection);
  }

  getRuntime(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  /** Snapshots for every known session (dashboard state + SSE priming). */
  listSnapshots(): ExperimentSnapshot[] {
    return [...this.runtimes.values()].map((runtime) => this.snapshot(runtime));
  }

  /** Build (or reuse) the runtime for one agent; auto-activates loop like pi. */
  runtimeFor(agent: Agent): SessionRuntime {
    const existing = this.runtimes.get(agent.id);
    if (existing !== undefined && existing.agentId === agent.id) return existing;

    const sessionCwd = canonicalPath(agent.session.header.cwd ?? process.cwd());
    const workDir = resolveWorkDir(sessionCwd);
    const jsonlPath = sessionFilePath(workDir, "log");

    let content = "";
    try {
      content = fs.readFileSync(jsonlPath, "utf-8");
    } catch {
      content = "";
    }
    const state = reconstructState(content);
    const config = readConfig(sessionCwd);

    const hasLog = state.results.length > 0;
    const runtime: SessionRuntime = {
      sessionId: agent.id,
      agentId: agent.id,
      sessionCwd,
      workDir,
      state,
      maxExperiments: config.maxIterations ?? null,
      running: null,
      runningAbort: null,
      lastRunChecks: null,
      lastRunDuration: null,
      experimentsThisSession: 0,
      loop:
        this.config.autoActivateLoop
        && hasLog
        && samePath(sessionCwd, workDir),
      loopStopReason: null,
      autoResumeTurns: 0,
      lastTail: undefined,
    };
    this.runtimes.set(agent.id, runtime);
    return runtime;
  }

  /**
   * Eagerly load the runtime for one agent when its resolved workdir already
   * has a `.auto/log.jsonl` (pi or this plugin). Mirrors what the first tool
   * call would build — the dashboard card appears without any tool use, and
   * `autoActivateLoop` re-arms the loop exactly as before. Returns null when
   * the workdir has no session log.
   */
  attachExisting(agent: Agent): ExperimentSnapshot | null {
    const sessionCwd = canonicalPath(agent.session.header.cwd ?? process.cwd());
    const workDir = resolveWorkDir(sessionCwd);
    if (!fs.existsSync(sessionFilePath(workDir, "log"))) return null;
    const runtime = this.runtimeFor(agent);
    this.emitState(runtime);
    return this.snapshot(runtime);
  }

  /**
   * Detect past autoresearch sessions (dashboard "Detect" button). Scans the
   * workdirs of live agent conversations — each cwd plus a shallow subtree,
   * and each cwd's parent one level — for `.auto/log.jsonl`, eagerly attaches
   * the ones whose resolved workdir matches a live conversation, and lists
   * the rest as unattached history. `sessionId` scopes the scan to one
   * conversation's cwd.
   */
  detect(sessionId?: string): DetectResult {
    const registry = (this.ctx as unknown as {
      agents?: {
        list?: () => Agent[];
        get?: (id: string) => Agent | undefined;
      };
    }).agents;
    let agents: Agent[] = [];
    if (sessionId !== undefined && sessionId !== "") {
      const agent = registry?.get?.(sessionId);
      if (agent !== undefined) agents = [agent];
    } else {
      agents = registry?.list?.() ?? [];
    }

    const attached: DetectedSession[] = [];
    const claimed = new Set<string>();
    const roots = new Set<string>();
    for (const agent of agents) {
      const cwd = canonicalPath(agent.session.header.cwd ?? process.cwd());
      roots.add(cwd);
      const snapshot = this.attachExisting(agent);
      if (snapshot !== null) {
        claimed.add(canonicalPath(snapshot.workDir));
        const last = snapshot.runs.length > 0 ? snapshot.runs[snapshot.runs.length - 1] : undefined;
        attached.push({
          sessionId: snapshot.sessionId,
          workDir: snapshot.workDir,
          name: snapshot.name,
          metricName: snapshot.metricName,
          metricUnit: snapshot.metricUnit,
          bestDirection: snapshot.bestDirection,
          metricLabel: snapshot.metricLabel,
          objectiveLabel: snapshot.objectiveLabel,
          currentSegment: snapshot.currentSegment,
          runs: snapshot.runs.length,
          bestMetric: snapshot.bestMetric,
          lastTimestamp: last !== undefined ? last.timestamp : null,
        });
      }
    }

    // Subtree scan under every root, plus one level of sibling projects via
    // the parent (depth 1) so a conversation parked inside one project still
    // sees past sessions in its siblings.
    const unattached: DetectedSession[] = [];
    const seen = new Set(claimed);
    const scanRoots: { root: string; depth: number }[] = [];
    for (const root of roots) scanRoots.push({ root, depth: SCAN_DEPTH });
    for (const root of roots) {
      const parent = path.dirname(root);
      if (parent !== root && parent !== path.parse(parent).root) scanRoots.push({ root: parent, depth: 1 });
    }
    for (const { root, depth } of scanRoots) {
      for (const dir of findAutoWorkdirs(root, depth)) {
        const canonical = canonicalPath(dir);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const summary = summarizeWorkdir(dir);
        if (summary !== null) unattached.push(summary);
      }
    }
    attached.sort(byRecency);
    unattached.sort(byRecency);
    return { attached, unattached };
  }

  /** Guard shared by every tool: resolve the runtime or produce an error text. */
  resolveAgent(exec: { agent?: Agent }): { runtime: SessionRuntime } | { error: string } {
    const agent = exec.agent;
    if (agent === undefined) {
      return { error: "autoresearch tools require an agent session (no agent on this tool call)." };
    }
    const workDirError = validateWorkDir(resolveWorkDir(canonicalPath(agent.session.header.cwd ?? process.cwd())));
    if (workDirError) return { error: workDirError };
    return { runtime: this.runtimeFor(agent) };
  }

  // -----------------------------------------------------------------------
  // Tool operations — bodies live in ./experiment-ops
  // -----------------------------------------------------------------------

  initExperiment(runtime: SessionRuntime, params: InitParams): ToolOutcome {
    return initExperimentOp(this, runtime, params);
  }

  async runExperiment(
    runtime: SessionRuntime,
    params: RunParams,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    return runExperimentOp(this, runtime, params, signal);
  }

  async logExperiment(
    runtime: SessionRuntime,
    params: LogParams,
  ): Promise<ToolOutcome> {
    return logExperimentOp(this, runtime, params);
  }

  /** @internal */ sessionSnapshot(state: SessionRuntime["state"], runtime: SessionRuntime) {
    return {
      metric_name: state.metricName,
      metric_unit: state.metricUnit,
      direction: state.bestDirection,
      baseline_metric: findBaselineMetric(state.results, state.currentSegment),
      best_metric: this.bestOf(state),
      run_count: state.results.length,
      goal: state.name ?? undefined,
      workDir: runtime.workDir,
    };
  }

  // -----------------------------------------------------------------------
  // Dashboard actions (SSE-driven)
  // -----------------------------------------------------------------------

  stopExperiment(sessionId: string): boolean {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined || runtime.runningAbort === null) return false;
    runtime.runningAbort.abort();
    return true;
  }

  setLoop(sessionId: string, on: boolean, reason?: string): boolean {
    const runtime = this.runtimes.get(sessionId);
    if (runtime === undefined) return false;
    runtime.loop = on;
    runtime.loopStopReason = on ? null : reason ?? "stopped from dashboard";
    this.emitState(runtime);
    return true;
  }

  loopRuntime(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }
}