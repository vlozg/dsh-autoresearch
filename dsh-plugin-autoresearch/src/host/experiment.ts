/**
 * ExperimentService — per-session autoresearch runtime over the `.auto/`
 * contract. Holds the reconstructed state (rebuilt from `.auto/log.jsonl` on
 * first touch — the file is the source of truth), the running-experiment
 * handle, loop mode, and the SSE publisher the client dashboard consumes.
 *
 * The three tools (tools.ts) delegate here; the auto-resume injector
 * (resume.ts) reads loop state and guards from here.
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
  AUTO_DIR,
  canonicalPath,
  ensureParentDir,
  readConfig,
  resolveWorkDir,
  runLogPath,
  runsDir,
  samePath,
  sessionFilePath,
  validateWorkDir,
} from "./paths";
import {
  reconstructState,
  serializeEntry,
  type ConfigHeader,
  type MetricDef,
  type RunEntry,
} from "./jsonl";
import {
  computeConfidence,
  countConsecutiveDiscardOrCrashResults,
  currentResults,
  findBaselineMetric,
  findBaselineSecondary,
  formatNum,
  parseMetricLines,
  type MetricMap,
} from "./metrics";
import { gitAutoCommit, gitRevert } from "./git";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, runCommand, LLM_MAX_BYTES, LLM_MAX_LINES } from "./run";
import { formatSize, truncateTail, type TruncateResult } from "./truncate";
import { fireHook } from "./hooks";

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

export class ExperimentService {
  private runtimes = new Map<string, SessionRuntime>();
  private listeners = new Set<(event: AutoResearchEvent) => void>();

  constructor(
    private readonly ctx: Context,
    private readonly config: PluginConfig,
  ) {}

  subscribe(listener: (event: AutoResearchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(event: AutoResearchEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One failing dashboard never breaks the loop.
      }
    }
  }

  private emitState(runtime: SessionRuntime): void {
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

  private bestOf(state: SessionRuntime["state"]): number | null {
    let best: number | null = null;
    for (const r of currentResults(state.results, state.currentSegment)) {
      if (r.metric <= 0) continue;
      if (best === null) {
        best = r.metric;
        continue;
      }
      const better =
        state.bestDirection === "lower" ? r.metric < best : r.metric > best;
      if (better) best = r.metric;
    }
    return best;
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

  isMeasureCommand(workDir: string, command: string): boolean {
    // Port of pi's isAutoresearchShCommand: the benchmark script must be the
    // first real command (env-var / env|time|nice|nohup prefixes allowed).
    let cmd = command.trim();
    cmd = cmd.replace(/^(?:\w+=\S*\s+)+/, "");
    let prev: string;
    do {
      prev = cmd;
      cmd = cmd.replace(/^(?:env|time|nice|nohup)(?:\s+-\S+(?:\s+\d+)?)*\s+/, "");
    } while (cmd !== prev);
    const autoDirPattern = `${AUTO_DIR.replace(".", "\\.")}`;
    return new RegExp(
      `^(?:(?:bash|sh|source)\\s+(?:-\\w+\\s+)*)?(?:/|\\.{1,2}/|[\\w.-]+/)*${autoDirPattern}/measure\\.sh(?:\\s|$)`,
    ).test(cmd);
  }

  // -----------------------------------------------------------------------
  // init_experiment
  // -----------------------------------------------------------------------

  initExperiment(runtime: SessionRuntime, params: InitParams): ToolOutcome {
    const header: ConfigHeader = {
      type: "config",
      name: params.name,
      metricName: params.metric_name,
      ...(params.metric_unit !== undefined ? { metricUnit: params.metric_unit } : {}),
      ...(params.direction !== undefined ? { bestDirection: params.direction } : {}),
    };

    const jsonlPath = sessionFilePath(runtime.workDir, "log");
    try {
      ensureParentDir(jsonlPath);
      fs.appendFileSync(jsonlPath, serializeEntry(header as unknown as Record<string, unknown>) + "\n");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { text: `❌ Failed to write ${jsonlPath}: ${msg}`, value: { ok: false, error: msg } };
    }

    // Reconstruct from the full file so segment semantics stay exact.
    runtime.state = reconstructState(fs.readFileSync(jsonlPath, "utf-8"));
    const reInit = runtime.state.currentSegment > 0;
    runtime.loop = true;
    runtime.loopStopReason = null;
    this.emitState(runtime);

    const text = [
      reInit
        ? `🔄 Re-initialized experiment session "${params.name}" — segment ${runtime.state.currentSegment} started (previous results kept in log.jsonl)`
        : `✅ Experiment session initialized: "${params.name}"`,
      `Metric: ${params.metric_name}${params.metric_unit ? ` (${params.metric_unit})` : ""} — ${runtime.state.bestDirection === "lower" ? "lower" : "higher"} is better`,
      runtime.maxExperiments !== null ? `Max experiments: ${runtime.maxExperiments}` : undefined,
      "",
      "Next: run the benchmark with run_experiment ({ command: 'bash .auto/measure.sh' }), then log the result with log_experiment. The auto-resume loop will keep asking for the next iteration when you go idle.",
    ].filter((line) => line !== undefined).join("\n");

    return { text, value: { ok: true, snapshot: this.snapshot(runtime) } };
  }

  // -----------------------------------------------------------------------
  // run_experiment
  // -----------------------------------------------------------------------

  async runExperiment(
    runtime: SessionRuntime,
    params: RunParams,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const workDir = runtime.workDir;

    // Segment-scoped max experiments gate.
    if (runtime.maxExperiments !== null && currentResults(runtime.state.results, runtime.state.currentSegment).length >= runtime.maxExperiments) {
      return {
        text: `❌ Maximum experiments reached (${runtime.maxExperiments}) for this segment. STOP the experiment loop now.`,
        value: { ok: false, blocked: "max-experiments" },
      };
    }

    const measureSh = sessionFilePath(workDir, "measure");
    const measureExists = fs.existsSync(measureSh);
    if (measureExists && !this.isMeasureCommand(workDir, params.command)) {
      return {
        text: `❌ ${AUTO_DIR}/measure.sh exists — you must run it instead of a custom command. Use: run_experiment({ command: "bash ${AUTO_DIR}/measure.sh" })`,
        value: { ok: false, blocked: "measure-sh-guard" },
      };
    }

    if (runtime.running !== null) {
      return {
        text: `❌ An experiment is already running (${runtime.running.command}). Wait for it to finish or stop it from the dashboard.`,
        value: { ok: false, blocked: "already-running" },
      };
    }

    const startedAt = Date.now();
    const abort = new AbortController();
    // Forward caller (user/tool) cancellation into the stop signal.
    const onCallerAbort = (): void => abort.abort();
    if (signal?.aborted) onCallerAbort();
    else signal?.addEventListener("abort", onCallerAbort, { once: true });
    runtime.running = { command: params.command, startedAt, phase: "running" };
    runtime.runningAbort = abort;
    this.emitState(runtime);

    const result = await runCommand({
      workDir,
      command: params.command,
      timeoutMs: (params.timeout_seconds ?? this.config.defaultExperimentTimeoutSeconds) * 1000,
      signal: abort.signal,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
      onUpdate: (payload) => {
        runtime.lastTail = payload.tail.content;
        this.publish({
          kind: "running",
          sessionId: runtime.sessionId,
          running: runtime.running ?? { command: params.command, startedAt, phase: "running" },
          tail: payload.tail.content,
        });
      },
    });

    const timedOut = result.killed && !result.aborted;
    const abortedByCaller = result.aborted;
    const durationSeconds = result.durationSeconds;
    runtime.lastRunDuration = durationSeconds;
    const benchmarkPassed = result.exitCode === 0 && !timedOut;
    const nextRunNumber = runtime.state.results.length + 1;

    // Backpressure checks after a passing benchmark.
    let checksPass: boolean | null = null;
    let checksTimedOut = false;
    let checksOutput = "";
    let checksDuration = 0;

    const checksFile = sessionFilePath(workDir, "checks");
    if (benchmarkPassed && fs.existsSync(checksFile)) {
      runtime.running = { command: params.command, startedAt, phase: "checks" };
      this.emitState(runtime);
      const checksRun = await runCommand({
        workDir,
        command: `bash "${checksFile}"`,
        timeoutMs: (params.checks_timeout_seconds ?? this.config.defaultChecksTimeoutSeconds) * 1000,
        signal: abort.signal,
        maxLines: 80,
        maxBytes: 32 * 1024,
      });
      checksDuration = checksRun.durationSeconds;
      checksTimedOut = checksRun.killed;
      checksPass = checksRun.exitCode === 0 && !checksRun.killed;
      checksOutput = checksRun.output.trim();
    }

    runtime.lastRunChecks = checksPass !== null ? { pass: checksPass, output: checksOutput, duration: checksDuration } : null;

    const passed = benchmarkPassed && (checksPass === null || checksPass);

    const totalLines = result.output === "" ? 0 : result.output.split("\n").length;
    const fullOutputPath = result.tempFilePath !== undefined || result.actualTotalBytes > LLM_MAX_BYTES || totalLines > LLM_MAX_LINES
      ? result.tempFilePath
      : undefined;

    const displayTruncation = truncateTail(result.output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
    const llmTruncation = truncateTail(result.output, { maxLines: LLM_MAX_LINES, maxBytes: LLM_MAX_BYTES });

    const parsedMetricMap: MetricMap = parseMetricLines(result.output);
    const parsedMetrics = parsedMetricMap.size > 0 ? Object.fromEntries(parsedMetricMap) : null;
    const parsedPrimary = parsedMetricMap.get(runtime.state.metricName) ?? null;

    // Persist the full run log under .auto/runs/<n>.log for the dashboard.
    let runLogFile: string | undefined;
    if (result.output.trim() !== "") {
      try {
        ensureParentDir(runsDir(workDir));
        runLogFile = runLogPath(workDir, nextRunNumber);
        fs.writeFileSync(runLogFile, result.output);
      } catch {
        runLogFile = fullOutputPath;
      }
    }

    signal?.removeEventListener("abort", onCallerAbort);
    runtime.running = null;
    runtime.runningAbort = null;
    runtime.lastTail = displayTruncation.content;
    this.emitState(runtime);

    let text = "";
    if (abortedByCaller) {
      text += `🛑 Experiment aborted after ${durationSeconds.toFixed(1)}s\n`;
    } else if (timedOut) {
      text += `⏰ TIMEOUT after ${durationSeconds.toFixed(1)}s\n`;
    } else if (!benchmarkPassed) {
      text += `💥 FAILED (exit code ${result.exitCode}) in ${durationSeconds.toFixed(1)}s\n`;
    } else if (checksTimedOut) {
      text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
      text += `⏰ CHECKS TIMEOUT (${AUTO_DIR}/checks.sh) after ${checksDuration.toFixed(1)}s\n`;
      text += `Log this as 'checks_failed' — the benchmark metric is valid but checks timed out.\n`;
    } else if (checksPass === false) {
      text += `✅ Benchmark PASSED in ${durationSeconds.toFixed(1)}s\n`;
      text += `💥 CHECKS FAILED (${AUTO_DIR}/checks.sh) in ${checksDuration.toFixed(1)}s\n`;
      text += `Log this as 'checks_failed' — the benchmark metric is valid but correctness checks did not pass.\n`;
    } else {
      text += `✅ PASSED in ${durationSeconds.toFixed(1)}s\n`;
      if (checksPass === true) text += `✅ Checks passed in ${checksDuration.toFixed(1)}s\n`;
    }

    const baseline = findBaselineMetric(runtime.state.results, runtime.state.currentSegment);
    if (baseline !== null) {
      text += `📊 Current best ${runtime.state.metricName}: ${formatNum(this.bestOf(runtime.state), runtime.state.metricUnit)}\n`;
    }

    if (parsedMetrics) {
      const secondary = Object.entries(parsedMetrics).filter(([k]) => k !== runtime.state.metricName);
      text += `\n📐 Parsed metrics:`;
      if (parsedPrimary !== null) {
        text += ` ★ ${runtime.state.metricName}=${formatNum(parsedPrimary, runtime.state.metricUnit)}`;
      }
      for (const [name, value] of secondary) {
        const def = runtime.state.secondaryMetrics.find((m) => m.name === name);
        text += ` ${name}=${formatNum(value, def?.unit ?? "")}`;
      }
      text += `\nUse these values directly in log_experiment (metric: ${parsedPrimary ?? "?"}, metrics: {${secondary.map(([k, v]) => `\"${k}\": ${v}`).join(", ")}})\n`;
      text += 'Describe the run as "Short title: what happened and why".\n';
    }

    text += `\n${llmTruncation.content}`;

    if (llmTruncation.truncated) {
      text += llmTruncation.truncatedBy === "lines"
        ? `\n\n[Showing last ${llmTruncation.outputLines} of ${llmTruncation.totalLines} lines.`
        : `\n\n[Showing last ${llmTruncation.outputLines} lines (${formatSize(LLM_MAX_BYTES)} limit).`;
      if (fullOutputPath) text += ` Full output: ${fullOutputPath}`;
      text += `]`;
    }

    if (checksPass === false) {
      const last80 = checksOutput.split("\n").slice(-80).join("\n");
      text += `\n\n── Checks output (last 80 lines) ──\n${last80}`;
    }

    return {
      text,
      value: {
        ok: true,
        passed,
        crashed: !passed,
        timedOut,
        exitCode: result.exitCode,
        durationSeconds,
        checksPass,
        checksDuration,
        parsedMetrics,
        parsedPrimary,
        metricName: runtime.state.metricName,
        fullOutputPath,
        runLogPath: runLogFile,
        tail: displayTruncation.content,
        truncation: llmTruncation.truncated ? llmTruncation : undefined,
      },
    };
  }

  // -----------------------------------------------------------------------
  // log_experiment
  // -----------------------------------------------------------------------

  async logExperiment(
    runtime: SessionRuntime,
    params: LogParams,
  ): Promise<ToolOutcome> {
    const workDir = runtime.workDir;
    const state = runtime.state;
    const secondaryMetrics = params.metrics ?? {};

    if (params.status === "keep" && runtime.lastRunChecks && !runtime.lastRunChecks.pass) {
      return {
        text: `❌ Cannot keep — ${AUTO_DIR}/checks.sh failed.\n\n${runtime.lastRunChecks.output.slice(-500)}\n\nLog as 'checks_failed' instead. The benchmark metric is valid but correctness checks did not pass.`,
        value: { ok: false, blocked: "checks-gate" },
      };
    }

    if (state.secondaryMetrics.length > 0) {
      const knownNames = new Set(state.secondaryMetrics.map((m) => m.name));
      const providedNames = new Set(Object.keys(secondaryMetrics));
      const missing = [...knownNames].filter((n) => !providedNames.has(n));
      if (missing.length > 0) {
        return {
          text: `❌ Missing secondary metrics: ${missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${[...knownNames].join(", ")}\nGot: ${[...providedNames].join(", ") || "(none)"}\n\nFix: include ${missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
          value: { ok: false, blocked: "missing-secondary-metrics", missing },
        };
      }
      const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
      if (newMetrics.length > 0 && !params.force) {
        return {
          text: `❌ New secondary metric${newMetrics.length > 1 ? "s" : ""} not previously tracked: ${newMetrics.join(", ")}\n\nExisting metrics: ${[...knownNames].join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
          value: { ok: false, blocked: "new-secondary-metrics", newMetrics },
        };
      }
    }

    const mergedASI = params.asi && Object.keys(params.asi).length > 0 ? params.asi : undefined;

    const experiment: RunEntry = {
      run: state.results.length + 1,
      commit: params.commit.slice(0, 7),
      metric: params.metric,
      metrics: { ...secondaryMetrics },
      status: params.status,
      description: params.description,
      timestamp: Date.now(),
      segment: state.currentSegment,
      confidence: null,
      ...(mergedASI ? { asi: mergedASI } : {}),
    };

    state.results.push(experiment);
    runtime.experimentsThisSession++;

    for (const name of Object.keys(secondaryMetrics)) {
      if (!state.secondaryMetrics.find((m) => m.name === name)) {
        let unit = "";
        if (name.endsWith("µs")) unit = "µs";
        else if (name.endsWith("_ms")) unit = "ms";
        else if (name.endsWith("_s") || name.endsWith("_sec")) unit = "s";
        else if (name.endsWith("_kb")) unit = "kb";
        else if (name.endsWith("_mb")) unit = "mb";
        state.secondaryMetrics.push({ name, unit });
      }
    }

    const confidence = computeConfidence(state.results, state.currentSegment, state.bestDirection);
    experiment.confidence = confidence;

    const segmentCount = currentResults(state.results, state.currentSegment).length;
    let text = `Logged #${experiment.run}: ${experiment.status} — ${experiment.description}`;

    const baseline = findBaselineMetric(state.results, state.currentSegment);
    if (baseline !== null) {
      text += `\nBaseline ${state.metricName}: ${formatNum(baseline, state.metricUnit)}`;
      if (segmentCount > 1 && params.status === "keep" && params.metric > 0) {
        const delta = params.metric - baseline;
        const pct = ((delta / baseline) * 100).toFixed(1);
        const sign = delta > 0 ? "+" : "";
        text += ` | this: ${formatNum(params.metric, state.metricUnit)} (${sign}${pct}%)`;
      }
    }

    if (Object.keys(secondaryMetrics).length > 0) {
      const baselines = findBaselineSecondary(state.results, state.currentSegment, state.secondaryMetrics);
      const parts: string[] = [];
      for (const [name, value] of Object.entries(secondaryMetrics)) {
        const def = state.secondaryMetrics.find((m) => m.name === name);
        let part = `${name}: ${formatNum(value, def?.unit ?? "")}`;
        const bv = baselines[name];
        if (bv !== undefined && segmentCount > 1 && bv !== 0) {
          const d = value - bv;
          const p = ((d / bv) * 100).toFixed(1);
          const s = d > 0 ? "+" : "";
          part += ` (${s}${p}%)`;
        }
        parts.push(part);
      }
      text += `\nSecondary: ${parts.join("  ")}`;
    }

    if (mergedASI) {
      const asiParts: string[] = [];
      for (const [k, v] of Object.entries(mergedASI)) {
        const s = typeof v === "string" ? v : JSON.stringify(v);
        asiParts.push(`${k}: ${s.length > 80 ? `${s.slice(0, 77)}…` : s}`);
      }
      if (asiParts.length > 0) text += `\n📋 ASI: ${asiParts.join(" | ")}`;
    }

    if (confidence !== null) {
      const confStr = confidence.toFixed(1);
      if (confidence >= 2.0) {
        text += `\n📊 Confidence: ${confStr}× noise floor — improvement is likely real`;
      } else if (confidence >= 1.0) {
        text += `\n📊 Confidence: ${confStr}× noise floor — improvement is above noise but marginal`;
      } else {
        text += `\n⚠️ Confidence: ${confStr}× noise floor — improvement is within noise. Consider re-running to confirm before keeping.`;
      }
    }

    text += `\n(${segmentCount} experiments${runtime.maxExperiments !== null ? ` / ${runtime.maxExperiments} max` : ""})`;

    // Git: commit on keep, revert otherwise (pi semantics).
    if (params.status === "keep") {
      const resultData: Record<string, unknown> = {
        status: params.status,
        [state.metricName || "metric"]: params.metric,
        ...secondaryMetrics,
      };
      const git = await gitAutoCommit(workDir, params.description, resultData);
      if (git.committed) {
        text += `\n📝 Git: committed${git.sha ? ` — ${git.sha}` : ""}`;
        if (git.sha) experiment.commit = git.sha;
      } else if (git.message) {
        text += `\n📝 Git: ${git.message}`;
      }
    } else {
      const revert = await gitRevert(workDir);
      text += revert.ok
        ? `\n📝 Git: reverted changes (${params.status}) — autoresearch files preserved`
        : `\n⚠️ Git revert failed: ${revert.message ?? ""}`;
    }

    // Append to log.jsonl AFTER git so the reverted tree still holds the file
    // (the entry is written post-revert; .auto/ is excluded from reverts).
    const jsonlPath = sessionFilePath(workDir, "log");
    const jsonlEntry: Record<string, unknown> = {
      ...experiment,
    };
    if (!mergedASI) delete jsonlEntry.asi;
    try {
      ensureParentDir(jsonlPath);
      fs.appendFileSync(jsonlPath, serializeEntry(jsonlEntry) + "\n");
    } catch (e) {
      text += `\n⚠️ Failed to write ${AUTO_DIR}/log.jsonl: ${e instanceof Error ? e.message : String(e)}`;
    }

    this.emitState(runtime);

    // after hook (stdout → result text)
    const afterSteer = await fireHook({
      event: "after",
      cwd: workDir,
      run_entry: jsonlEntry,
      session: this.sessionSnapshot(state, runtime),
    });
    if (afterSteer) text += `\n\n── Hook (after) ──\n${afterSteer}`;

    runtime.running = null;
    runtime.lastRunChecks = null;
    runtime.lastRunDuration = null;

    const limitReached = runtime.maxExperiments !== null && segmentCount >= runtime.maxExperiments;
    if (limitReached) {
      text += `\n\n🛑 Maximum experiments reached (${runtime.maxExperiments}). STOP the experiment loop now.`;
      runtime.loop = false;
      runtime.loopStopReason = `max experiments reached (${runtime.maxExperiments})`;
      this.emitState(runtime);
    } else if (runtime.loop) {
      text += "\n\nBefore choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.";
      const beforeSteer = await fireHook({
        event: "before",
        cwd: workDir,
        next_run: experiment.run + 1,
        last_run: jsonlEntry,
        session: this.sessionSnapshot(state, runtime),
      });
      if (beforeSteer) text += `\n\n── Hook (before) ──\n${beforeSteer}`;
    }

    return {
      text,
      value: {
        ok: true,
        experiment: { ...experiment },
        segmentCount,
        maxExperiments: runtime.maxExperiments,
        confidence,
        loop: runtime.loop,
        loopStopReason: runtime.loopStopReason,
      },
    };
  }

  private sessionSnapshot(state: SessionRuntime["state"], runtime: SessionRuntime) {
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
