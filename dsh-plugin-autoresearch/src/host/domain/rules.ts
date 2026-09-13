/**
 * Experiment loop rules as pure predicates/gates: the measure.sh guard
 * (port of pi's isAutoresearchShCommand) and the secondary-metrics gate
 * enforced by log_experiment. Text rendering of gate results stays in the
 * app layer's use cases.
 */

import { AUTO_DIR, type MetricDef } from "./model";

/**
 * The benchmark script must be the first real command (env-var / env|time|
 * nice|nohup prefixes allowed).
 */
export function isMeasureCommand(command: string): boolean {
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

export type SecondaryMetricsGate =
  | { ok: true }
  | { ok: false; blocked: "missing-secondary-metrics"; missing: string[] }
  | { ok: false; blocked: "new-secondary-metrics"; newMetrics: string[] };

/**
 * Every previously tracked secondary metric must be provided again; new
 * names require force. Passes with zero known metrics.
 */
export function secondaryMetricsGate(
  known: MetricDef[],
  provided: Record<string, number>,
  force: boolean,
): SecondaryMetricsGate {
  if (known.length === 0) return { ok: true };
  const knownNames = new Set(known.map((m) => m.name));
  const providedNames = new Set(Object.keys(provided));
  const missing = [...knownNames].filter((n) => !providedNames.has(n));
  if (missing.length > 0) return { ok: false, blocked: "missing-secondary-metrics", missing };
  const newMetrics = [...providedNames].filter((n) => !knownNames.has(n));
  if (newMetrics.length > 0 && !force) return { ok: false, blocked: "new-secondary-metrics", newMetrics };
  return { ok: true };
}