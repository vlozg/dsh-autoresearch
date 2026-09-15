/**
 * ExperimentService — per-session autoresearch runtime over the `.auto/`
 * contract. Holds the reconstructed state (rebuilt from `.auto/log.jsonl` on
 * first touch — the file is the source of truth), the running-experiment
 * handle, loop mode, and the SSE publisher the client dashboard consumes.
 *
 * Module layout: driven-side ports in ./ports (node adapters under
 * ../adapters, wired by the host entry), contracts in ./contracts, tool
 * operation bodies in ./init-experiment + ./run-experiment +
 * ./log-experiment. The three tools (infra/tools.ts) delegate here; the
 * auto-resume injector (infra/resume.ts) reads loop state and guards.
 */

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import * as path from "node:path";
import { DETECT_SCAN_DEPTH } from "./ports";
import type { DetectResult, DetectedSession, LogStore, ServiceDeps } from "./ports";
import { bestMetric, computeConfidence, findBaselineMetric } from "../domain/metrics";
import { initExperimentOp } from "./init-experiment";
import { runExperimentOp } from "./run-experiment";
import { logExperimentOp } from "./log-experiment";
import type {
  AutoResearchEvent,
  ExperimentSnapshot,
  InitParams,
  LogParams,
  PluginConfig,
  RunParams,
  SessionRuntime,
  ToolOutcome,
} from "./contracts";

export * from "./contracts";

/** Newest activity first; sessions without runs sort last (detect output ordering). */
function byRecency(a: DetectedSession, b: DetectedSession): number {
  return (b.lastTimestamp ?? 0) - (a.lastTimestamp ?? 0);
}

export class ExperimentService {
  private runtimes = new Map<string, SessionRuntime>();
  private listeners = new Set<(event: AutoResearchEvent) => void>();

  constructor(
    private readonly ctx: Context,
    /** @internal */ readonly config: PluginConfig,
    /** @internal */ readonly deps: ServiceDeps,
  ) {}

  /** Driven-side session storage (paths + JSONL + workdir resolution). */
  get logStore(): LogStore {
    return this.deps.logStore;
  }
  /** @internal */ get clock() { return this.deps.clock; }
  /** @internal */ get git() { return this.deps.git; }
  /** @internal */ get runner() { return this.deps.runner; }
  /** @internal */ get hooks() { return this.deps.hooks; }

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

    const sessionCwd = this.logStore.canonicalPath(agent.session.header.cwd ?? process.cwd());
    const workDir = this.logStore.resolveWorkDir(sessionCwd);
    const state = this.logStore.loadState(workDir);
    const config = this.logStore.readConfig(sessionCwd);

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
        && this.logStore.samePath(sessionCwd, workDir),
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
    const sessionCwd = this.logStore.canonicalPath(agent.session.header.cwd ?? process.cwd());
    const workDir = this.logStore.resolveWorkDir(sessionCwd);
    if (!this.logStore.exists(workDir, "log")) return null;
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
      const cwd = this.logStore.canonicalPath(agent.session.header.cwd ?? process.cwd());
      roots.add(cwd);
      const snapshot = this.attachExisting(agent);
      if (snapshot !== null) {
        claimed.add(this.logStore.canonicalPath(snapshot.workDir));
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
    for (const root of roots) scanRoots.push({ root, depth: DETECT_SCAN_DEPTH });
    for (const root of roots) {
      const parent = path.dirname(root);
      if (parent !== root && parent !== path.parse(parent).root) scanRoots.push({ root: parent, depth: 1 });
    }
    for (const { root, depth } of scanRoots) {
      for (const dir of this.deps.scanner.findAutoWorkdirs(root, depth)) {
        const canonical = this.logStore.canonicalPath(dir);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const summary = this.deps.scanner.summarize(dir);
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
    const workDirError = this.logStore.validateWorkDir(this.logStore.resolveWorkDir(this.logStore.canonicalPath(agent.session.header.cwd ?? process.cwd())));
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