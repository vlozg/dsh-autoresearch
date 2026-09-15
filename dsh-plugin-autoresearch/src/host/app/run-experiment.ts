/**
 * run_experiment — execute one benchmark (or .auto/measure.sh-guarded
 * command) under the runner port with a wall-clock timeout, run the
 * optional checks.sh backpressure pass, persist the run log, and render
 * the result text (truncated tails, parsed metrics, confidence hints).
 */

import type { ExperimentService } from "./experiment-service";
import { AUTO_DIR } from "../domain/model";
import { currentResults, findBaselineMetric, formatNum, parseMetricLines, type MetricMap } from "../domain/metrics";
import { isMeasureCommand } from "../domain/rules";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, LLM_MAX_BYTES, LLM_MAX_LINES } from "./ports";
import { formatSize, truncateTail } from "./truncate";
import type { RunParams, SessionRuntime, ToolOutcome } from "./contracts";

export async function runExperimentOp(
  svc: ExperimentService,
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

    const measureExists = svc.logStore.exists(workDir, "measure");
    if (measureExists && !isMeasureCommand(params.command)) {
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

    const startedAt = svc.clock.now();
    const abort = new AbortController();
    // Forward caller (user/tool) cancellation into the stop signal.
    const onCallerAbort = (): void => abort.abort();
    if (signal?.aborted) onCallerAbort();
    else signal?.addEventListener("abort", onCallerAbort, { once: true });
    runtime.running = { command: params.command, startedAt, phase: "running" };
    runtime.runningAbort = abort;
    svc.emitState(runtime);

    const result = await svc.runner.run({
      workDir,
      command: params.command,
      timeoutMs: (params.timeout_seconds ?? svc.config.defaultExperimentTimeoutSeconds) * 1000,
      signal: abort.signal,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
      onUpdate: (payload) => {
        runtime.lastTail = payload.tail.content;
        svc.publish({
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

    const checksFile = svc.logStore.sessionPath(workDir, "checks");
    if (benchmarkPassed && svc.logStore.exists(workDir, "checks")) {
      runtime.running = { command: params.command, startedAt, phase: "checks" };
      svc.emitState(runtime);
      const checksRun = await svc.runner.run({
        workDir,
        command: `bash "${checksFile}"`,
        timeoutMs: (params.checks_timeout_seconds ?? svc.config.defaultChecksTimeoutSeconds) * 1000,
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
      runLogFile = svc.logStore.writeRunLog(workDir, nextRunNumber, result.output);
      if (runLogFile === undefined) runLogFile = fullOutputPath;
    }

    signal?.removeEventListener("abort", onCallerAbort);
    runtime.running = null;
    runtime.runningAbort = null;
    runtime.lastTail = displayTruncation.content;
    svc.emitState(runtime);

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
      text += `📊 Current best ${runtime.state.metricName}: ${formatNum(svc.bestOf(runtime.state), runtime.state.metricUnit)}\n`;
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
      text += 'When logging, pass title (max 70 chars) and summary (max 180 chars) plus description carrying the full evidence.\n';
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