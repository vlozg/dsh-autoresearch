/**
 * log_experiment — record one run's outcome. Applies the checks gate and
 * the secondary-metrics gate, appends the run entry to `.auto/log.jsonl`
 * after git commit/revert, fires the after/before hooks, and renders the
 * loop-steering text.
 */

import type { ExperimentService } from "./experiment-service";
import { AUTO_DIR, registerSecondaryMetrics, type RunEntry } from "../domain/model";
import {
  computeConfidence,
  currentResults,
  findBaselineMetric,
  findBaselineSecondary,
  formatNum,
} from "../domain/metrics";
import { secondaryMetricsGate } from "../domain/rules";
import type { LogParams, SessionRuntime, ToolOutcome } from "./contracts";

export async function logExperimentOp(
  svc: ExperimentService,
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

    const gate = secondaryMetricsGate(state.secondaryMetrics, secondaryMetrics, params.force === true);
    if (!gate.ok) {
      const knownNames = state.secondaryMetrics.map((m) => m.name);
      const providedNames = Object.keys(secondaryMetrics);
      if (gate.blocked === "missing-secondary-metrics") {
        return {
          text: `❌ Missing secondary metrics: ${gate.missing.join(", ")}\n\nYou must provide all previously tracked metrics. Expected: ${knownNames.join(", ")}\nGot: ${providedNames.join(", ") || "(none)"}\n\nFix: include ${gate.missing.map((m) => `"${m}": <value>`).join(", ")} in the metrics parameter.`,
          value: { ok: false, blocked: "missing-secondary-metrics", missing: gate.missing },
        };
      }
      return {
        text: `❌ New secondary metric${gate.newMetrics.length > 1 ? "s" : ""} not previously tracked: ${gate.newMetrics.join(", ")}\n\nExisting metrics: ${knownNames.join(", ")}\n\nIf this metric has proven very valuable to watch, call log_experiment again with force: true to add it. Otherwise, remove it from the metrics parameter.`,
        value: { ok: false, blocked: "new-secondary-metrics", newMetrics: gate.newMetrics },
      };
    }

    const mergedASI = params.asi && Object.keys(params.asi).length > 0 ? params.asi : undefined;

    const experiment: RunEntry = {
      run: state.results.length + 1,
      commit: params.commit.slice(0, 7),
      metric: params.metric,
      metrics: { ...secondaryMetrics },
      status: params.status,
      description: params.description,
      ...(typeof params.title === "string" && params.title !== "" ? { title: params.title } : {}),
      ...(typeof params.summary === "string" && params.summary !== "" ? { summary: params.summary } : {}),
      timestamp: svc.clock.now(),
      segment: state.currentSegment,
      confidence: null,
      ...(mergedASI ? { asi: mergedASI } : {}),
    };

    state.results.push(experiment);
    runtime.experimentsThisSession++;

    registerSecondaryMetrics(state, secondaryMetrics);

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
      const git = await svc.git.autoCommit(workDir, params.description, resultData);
      if (git.committed) {
        text += `\n📝 Git: committed${git.sha ? ` — ${git.sha}` : ""}`;
        if (git.sha) experiment.commit = git.sha;
      } else if (git.message) {
        text += `\n📝 Git: ${git.message}`;
      }
    } else {
      const revert = await svc.git.revert(workDir);
      text += revert.ok
        ? `\n📝 Git: reverted changes (${params.status}) — autoresearch files preserved`
        : `\n⚠️ Git revert failed: ${revert.message ?? ""}`;
    }

    // Append to log.jsonl AFTER git so the reverted tree still holds the file
    // (the entry is written post-revert; .auto/ is excluded from reverts).
    const jsonlEntry: Record<string, unknown> = {
      ...experiment,
    };
    if (!mergedASI) delete jsonlEntry.asi;
    const append = svc.logStore.appendEntry(workDir, jsonlEntry);
    if (!append.ok) {
      text += `\n⚠️ Failed to write ${AUTO_DIR}/log.jsonl: ${append.error}`;
    }

    svc.emitState(runtime);

    // after hook (stdout → result text)
    const afterSteer = await svc.hooks.fire({
      event: "after",
      cwd: workDir,
      run_entry: jsonlEntry,
      session: svc.sessionSnapshot(state, runtime),
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
      svc.emitState(runtime);
    } else if (runtime.loop) {
      text += "\n\nBefore choosing the next experiment, consider whether this result or discovery invalidates a previous discard's rollback reason. If so, name what changed and weigh a targeted retry against other candidates. Otherwise, move on. Don't revive a discarded idea without a changed assumption. Verification reruns to resolve measurement noise are separate.";
      const beforeSteer = await svc.hooks.fire({
        event: "before",
        cwd: workDir,
        next_run: experiment.run + 1,
        last_run: jsonlEntry,
        session: svc.sessionSnapshot(state, runtime),
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