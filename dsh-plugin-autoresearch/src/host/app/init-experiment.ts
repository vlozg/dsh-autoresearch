/**
 * init_experiment — start (or re-start, bumping the segment) an experiment
 * session. Writes the config header to `.auto/log.jsonl`, rebuilds state
 * from the full file, and arms the loop.
 */

import type { ConfigHeader, JsonlEntry } from "../domain/model";
import type { InitParams, SessionRuntime, ToolOutcome } from "./contracts";
import type { ExperimentService } from "./experiment-service";

export function initExperimentOp(
  svc: ExperimentService,
  runtime: SessionRuntime,
  params: InitParams,
): ToolOutcome {
    const header: ConfigHeader = {
      type: "config",
      name: params.name,
      metricName: params.metric_name,
      ...(params.metric_unit !== undefined ? { metricUnit: params.metric_unit } : {}),
      ...(params.direction !== undefined ? { bestDirection: params.direction } : {}),
      ...(params.metric_label !== undefined ? { metricLabel: params.metric_label } : {}),
      ...(params.objective_label !== undefined ? { objectiveLabel: params.objective_label } : {}),
    };

    const append = svc.logStore.appendEntry(runtime.workDir, header as unknown as JsonlEntry);
    if (!append.ok) {
      return { text: `❌ Failed to write ${append.path}: ${append.error}`, value: { ok: false, error: append.error } };
    }

    // Reconstruct from the full file so segment semantics stay exact.
    runtime.state = svc.logStore.loadState(runtime.workDir);
    const reInit = runtime.state.currentSegment > 0;
    runtime.loop = true;
    runtime.loopStopReason = null;
    svc.emitState(runtime);

    const text = [
      reInit
        ? `🔄 Re-initialized experiment session "${params.name}" — segment ${runtime.state.currentSegment} started (previous results kept in log.jsonl)`
        : `✅ Experiment session initialized: "${params.name}"`,
      `Metric: ${params.metric_name}${params.metric_unit ? ` (${params.metric_unit})` : ""} — ${runtime.state.bestDirection === "lower" ? "lower" : "higher"} is better`,
      runtime.maxExperiments !== null ? `Max experiments: ${runtime.maxExperiments}` : undefined,
      "",
      "Next: run the benchmark with run_experiment ({ command: 'bash .auto/measure.sh' }), then log the result with log_experiment. The auto-resume loop will keep asking for the next iteration when you go idle.",
    ].filter((line) => line !== undefined).join("\n");

    return { text, value: { ok: true, snapshot: svc.snapshot(runtime) } };
}