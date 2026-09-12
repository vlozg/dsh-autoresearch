/**
 * METRIC line parsing and confidence scoring (port of pi-autoresearch).
 *
 * Benchmark scripts emit `METRIC name=value` lines; the primary metric value
 * matching the configured metricName feeds keep/discard decisions, confidence
 * = |best_delta| / MAD over same-segment results (advisory only — never used
 * to auto-discard).
 */

import type { RunEntry } from "./jsonl";

const METRIC_LINE_PREFIX = "METRIC";
const METRIC_LINE_REGEX = /^METRIC\s+([\w.µ]+)=(\S+)\s*$/gm;
const DENIED_METRIC_NAMES = ["__proto__", "constructor", "prototype"];

export type MetricMap = Map<string, number>;

/** Parse all `METRIC name=value` lines; later duplicates win; non-finite values ignored. */
export function parseMetricLines(output: string): MetricMap {
  const metrics: MetricMap = new Map();
  if (!output.includes(METRIC_LINE_PREFIX)) return metrics;

  METRIC_LINE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = METRIC_LINE_REGEX.exec(output)) !== null) {
    const [, name, rawValue] = match;
    if (DENIED_METRIC_NAMES.includes(name)) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    metrics.set(name, value);
  }
  return metrics;
}

export function isBetter(current: number, best: number, direction: "lower" | "higher"): boolean {
  return direction === "lower" ? current < best : current > best;
}

/** Median of a numeric array (0 for empty). */
export function sortedMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Results in the current segment only. */
export function currentResults(results: RunEntry[], segment: number): RunEntry[] {
  return results.filter((r) => r.segment === segment);
}

/** Baseline = first experiment metric in the current segment. */
export function findBaselineMetric(results: RunEntry[], segment: number): number | null {
  const cur = currentResults(results, segment);
  return cur.length > 0 ? cur[0].metric : null;
}

/**
 * Confidence score: best kept improvement over baseline as a multiple of the
 * MAD-based noise floor of all metric values in the current segment.
 * null when < 3 data points, MAD is 0, or no kept improvement exists.
 */
export function computeConfidence(
  results: RunEntry[],
  segment: number,
  direction: "lower" | "higher",
): number | null {
  const cur = currentResults(results, segment).filter((r) => r.metric > 0);
  if (cur.length < 3) return null;

  const values = cur.map((r) => r.metric);
  const median = sortedMedian(values);
  const deviations = values.map((v) => Math.abs(v - median));
  const mad = sortedMedian(deviations);
  if (mad === 0) return null;

  const baseline = findBaselineMetric(results, segment);
  if (baseline === null) return null;

  let bestKept: number | null = null;
  for (const r of cur) {
    if (r.status === "keep" && r.metric > 0) {
      if (bestKept === null || isBetter(r.metric, bestKept, direction)) {
        bestKept = r.metric;
      }
    }
  }
  if (bestKept === null || bestKept === baseline) return null;

  const delta = Math.abs(bestKept - baseline);
  return delta / mad;
}

/** Secondary metric baselines = first value per name in the current segment. */
export function findBaselineSecondary(
  results: RunEntry[],
  segment: number,
  secondaryMetrics: { name: string }[],
): Record<string, number> {
  const cur = currentResults(results, segment);
  const baselines: Record<string, number> = {};
  for (const def of secondaryMetrics) {
    const first = cur.find((r) => r.metrics[def.name] !== undefined);
    if (first) baselines[def.name] = first.metrics[def.name];
  }
  return baselines;
}

/** Count trailing discard/crash results in the current segment (auto-resume guard). */
export function countConsecutiveDiscardOrCrashResults(results: RunEntry[], segment: number): number {
  let count = 0;
  for (let i = results.length - 1; i >= 0; i--) {
    const result = results[i];
    if (result.segment !== segment) break;
    if (result.status === "discard" || result.status === "crash") {
      count++;
      continue;
    }
    break;
  }
  return count;
}

/** Compact number formatting: integers bare, fractions 2dp. */
export function formatNum(value: number | null, unit: string): string {
  if (value === null) return "—";
  const u = unit || "";
  const n = Math.abs(value) < 1e21 ? value : value;
  if (n === Math.round(n)) return `${String(Math.round(n))}${u}`;
  return `${n.toFixed(2)}${u}`;
}

/** "Xm YYs" / "YYs" elapsed formatting. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}
