/**
 * `.auto/log.jsonl` byte-format handling (port of pi-autoresearch jsonl.ts):
 * line parsing, entry predicates, state reconstruction from file content,
 * and serialization. The entry schema and state fold are domain rules — see
 * ./domain/model; this module is only the JSONL framing around them. The
 * JSONL file is the source of truth; in-memory state is always rebuilt from
 * it so restarts and compaction cannot lose experiment history.
 */

import {
  initialExperimentState,
  isObjectRecord,
  nextSegment,
  registerSecondaryMetrics,
  runFrom,
  updateConfig,
  type ConfigHeader,
  type ExperimentState,
  type JsonlEntry,
} from "../domain/model";

export type { JsonlEntry, ConfigHeader, RunEntry, MetricDef } from "../domain/model";
export { inferMetricUnit } from "../domain/model";

export function parseJsonlEntry(line: string): JsonlEntry | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isConfigEntry(entry: unknown): entry is ConfigHeader {
  return isObjectRecord(entry) && entry.type === "config";
}

export function isRunEntry(entry: unknown): entry is JsonlEntry {
  return isObjectRecord(entry) && typeof entry.run === "number";
}

function firstConfigEntry(jsonlContent: string): ConfigHeader | null {
  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);
    if (isConfigEntry(entry)) return entry;
  }
  return null;
}

export function hasConfigHeader(jsonlContent: string): boolean {
  return firstConfigEntry(jsonlContent) !== null;
}

export function extractSessionName(jsonlContent: string): string {
  return firstConfigEntry(jsonlContent)?.name || "Autoresearch";
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

export function reconstructState(jsonlContent: string): ExperimentState {
  const state = initialExperimentState();
  let segment = 0;

  for (const line of nonEmptyLines(jsonlContent)) {
    const entry = parseJsonlEntry(line);
    if (!entry) continue;

    if (isConfigEntry(entry)) {
      updateConfig(state, entry);
      segment = nextSegment(state, segment);
      state.currentSegment = segment;
      continue;
    }

    if (!isRunEntry(entry)) continue;

    const run = runFrom(entry, segment);
    state.results.push(run);
    registerSecondaryMetrics(state, run.metrics);
  }

  return state;
}

/** One JSON line per entry; caller appends "\n". */
export function serializeEntry(entry: JsonlEntry): string {
  return JSON.stringify(entry);
}