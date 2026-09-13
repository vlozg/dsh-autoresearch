/**
 * The three autoresearch tools (port of pi-autoresearch's tool surface):
 *
 *   init_experiment  — declare name/metric/direction (re-init starts a segment)
 *   run_experiment   — run the benchmark (measure.sh guard, timeout, checks)
 *   log_experiment   — record result, keep-commit / auto-revert, confidence
 *
 * Model-facing text mirrors pi's responses (carried in the canonical value's
 * ${'"'}text" field; `render` emits it verbatim); the rest of the canonical value
 * feeds the M2 client toolviews.
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ExperimentService } from "./experiment";

/** Model-facing text render shared by all three tools. */
const render = (_args: unknown, value: unknown): ContentBlock[] => [{
  type: "text",
  text: typeof value === "object" && value !== null && "text" in value && typeof (value as { text?: unknown }).text === "string"
    ? (value as { text: string }).text
    : JSON.stringify(value),
}];

export function buildAutoResearchTools(service: ExperimentService) {
  const initExperiment = defineTool({
    name: "init_experiment",
    description:
      "Initialize (or re-initialize) an autoresearch session: a name, the primary optimization metric, and its unit/direction. " +
      "Re-initializing starts a new segment (previous results stay in .auto/log.jsonl). Enables the auto-resume loop: when you go idle, " +
      "the plugin keeps prompting you to run the next iteration until the loop is stopped or the max-experiments limit is reached.",
    parameters: {
      name: {
        type: "string",
        required: true,
        description: 'Human-readable name for this experiment session (e.g. "Optimizing liquid for fastest execution and parsing")',
      },
      metric_name: {
        type: "string",
        required: true,
        description: 'Display name for the primary metric (e.g. "total_us", "bundle_kb"). Shown in the dashboard header.',
      },
      metric_unit: {
        type: "string",
        description: 'Unit for the primary metric. Use "us", "ms", "s", "kb", "mb", or "" for unitless. Default: ""',
      },
      direction: {
        type: "string",
        enum: ["lower", "higher"],
        description: 'Whether "lower" or "higher" is better for the primary metric. Default: "lower".',
      },
    },
    output: { schema: { type: "json" }, render },
    async execute(args, exec) {
      const r = service.resolveAgent(exec as never);
      if ("error" in r) return { ok: false, error: r.error, text: "❌ " + r.error } as unknown as import("@deepseek-ai/dsh-session").JsonValue;
      const outcome = service.initExperiment(r.runtime, args as never);
      return { ...outcome.value, text: outcome.text } as unknown as import("@deepseek-ai/dsh-session").JsonValue;
    },
  });

  const runExperiment = defineTool({
    name: "run_experiment",
    description:
      "Run the benchmark for the current autoresearch session and capture output, wall-clock time, and METRIC name=value lines. " +
      "Once .auto/measure.sh exists it MUST be the command (e.g. 'bash .auto/measure.sh'). After a passing benchmark, .auto/checks.sh " +
      "(if present) runs as a correctness gate; a checks failure is logged as 'checks_failed'.",
    parameters: {
      command: {
        type: "string",
        required: true,
        description: "Shell command to run (e.g. 'bash .auto/measure.sh')",
      },
      timeout_seconds: {
        type: "number",
        description: "Kill after this many seconds (default: 600)",
      },
      checks_timeout_seconds: {
        type: "number",
        description: "Kill .auto/checks.sh after this many seconds (default: 300). Only relevant when the checks file exists.",
      },
    },
    output: { schema: { type: "json" }, render },
    async execute(args, exec) {
      const r = service.resolveAgent(exec as never);
      if ("error" in r) return { ok: false, error: r.error, text: "❌ " + r.error } as unknown as import("@deepseek-ai/dsh-session").JsonValue;
      const outcome = await service.runExperiment(r.runtime, args as never, exec.signal);
      return { ...outcome.value, text: outcome.text } as unknown as import("@deepseek-ai/dsh-session").JsonValue;
    },
  });

  const logExperiment = defineTool({
    name: "log_experiment",
    description:
      "Record an experiment result. Tracks metrics, updates the dashboard, and manages git: 'keep' auto-commits, " +
      "'discard'/'crash'/'checks_failed' auto-revert code changes (.auto/ is preserved). Call after every run_experiment.",
    parameters: {
      commit: {
        type: "string",
        required: true,
        description: "Git commit hash (short, 7 chars)",
      },
      metric: {
        type: "number",
        required: true,
        description: "The primary optimization metric value (e.g. seconds, val_bpb). 0 for crashes.",
      },
      status: {
        type: "string",
        enum: ["keep", "discard", "crash", "checks_failed"],
        required: true,
        description: "keep only when the PRIMARY metric improved",
      },
      description: {
        type: "string",
        required: true,
        description:
          'What this experiment tried, written as "Short title: what happened and why" — the sidebar shows the title and finding separately',
      },
      metrics: {
        type: "object",
        additionalProperties: true,
        description: 'Additional metrics to track as { name: value } pairs, e.g. { "compile_us": 4200 }. Shown alongside the primary metric for tradeoff monitoring.',
      },
      force: {
        type: "boolean",
        description: "Set true to allow adding a new secondary metric that wasn't tracked before. Only for metrics proven valuable.",
      },
      asi: {
        type: "object",
        additionalProperties: true,
        description: 'Actionable Side Information — structured diagnostics for this run (free-form key/value pairs). At minimum {"hypothesis": "what you tried"}; on discard/crash add rollback_reason and next_action_hint. This is the only structured memory that survives reverts.',
      },
    },
    output: { schema: { type: "json" }, render },
    async execute(args, exec) {
      const r = service.resolveAgent(exec as never);
      if ("error" in r) return { ok: false, error: r.error, text: "❌ " + r.error } as unknown as import("@deepseek-ai/dsh-session").JsonValue;
      const outcome = await service.logExperiment(r.runtime, args as never);
      return { ...outcome.value, text: outcome.text } as unknown as import("@deepseek-ai/dsh-session").JsonValue;
    },
  });

  return { initExperiment, runExperiment, logExperiment };
}
