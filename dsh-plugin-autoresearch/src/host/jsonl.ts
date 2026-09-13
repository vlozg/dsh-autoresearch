/**
 * `.auto/log.jsonl` schema and reconstruction (port of pi-autoresearch jsonl.ts).
 * The JSONL file is the source of truth; in-memory state is always rebuilt
 * from it so restarts and compaction cannot lose experiment history.
 */

export type JsonlEntry = Record<string, unknown>;

export interface ConfigHeader {
  type: "config";
  name?: string;
  metricName?: string;
  metricUnit?: string;
  bestDirection?: "lower" | "higher";
  metricLabel?: string;
  objectiveLabel?: string;
}

export interface RunEntry {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  title?: string;
  summary?: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
  asi?: Record<string, unknown>;
}

export interface MetricDef {
  name: string;
  unit: string;
}

export interface ReconstructedState {
  name: string | null;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  metricLabel: string | null;
  objectiveLabel: string | null;
  currentSegment: number;
  results: RunEntry[];
  secondaryMetrics: MetricDef[];
}

const DEFAULT_METRIC_NAME = "metric";
const DEFAULT_METRIC_UNIT = "";
const DEFAULT_DIRECTION = "lower" as const;

function isObjectRecord(value: unknown): value is JsonlEntry {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyLines(text: string): string[] {
  return text.split("\n").filter(Boolean);
}

/** Infer a display unit from a secondary metric name suffix (pi parity). */
export function inferMetricUnit(name: string): string {
  if (name.endsWith("µs")) return "µs";
  if (name.endsWith("_ms")) return "ms";
  if (name.endsWith("_s") || name.endsWith("_sec")) return "s";
  if (name.endsWith("_kb")) return "kb";
  if (name.endsWith("_mb")) return "mb";
  return "";
}

function metricMapFrom(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) return {};
  const metrics: Record<string, number> = {};
  for (const [name, metric] of Object.entries(value)) {
    if (typeof metric === "number") metrics[name] = metric;
  }
  return metrics;
}

function statusFrom(value: unknown): RunEntry["status"] {
  if (value === "discard") return "discard";
  if (value === "crash") return "crash";
  if (value === "checks_failed") return "checks_failed";
  return "keep";
}

function asiFrom(value: unknown): Record<string, unknown> | undefined {
  return isObjectRecord(value) ? value : undefined;
}

function reconstructedState(): ReconstructedState {
  return {
    name: null,
    metricName: DEFAULT_METRIC_NAME,
    metricUnit: DEFAULT_METRIC_UNIT,
    bestDirection: DEFAULT_DIRECTION,
    metricLabel: null,
    objectiveLabel: null,
    currentSegment: 0,
    results: [],
    secondaryMetrics: [],
  };
}

function updateConfig(state: ReconstructedState, entry: ConfigHeader): void {
  if (typeof entry.name === "string") state.name = entry.name;
  if (typeof entry.metricName === "string") state.metricName = entry.metricName;
  if (typeof entry.metricUnit === "string") state.metricUnit = entry.metricUnit;
  if (typeof entry.metricLabel === "string") state.metricLabel = entry.metricLabel;
  if (typeof entry.objectiveLabel === "string") state.objectiveLabel = entry.objectiveLabel;
  state.bestDirection = entry.bestDirection === "higher" ? "higher" : DEFAULT_DIRECTION;
}

function nextSegment(state: ReconstructedState, segment: number): number {
  if (state.results.length === 0) return segment;
  state.secondaryMetrics = [];
  return segment + 1;
}

function runFrom(entry: JsonlEntry, segment: number): RunEntry {
  return {
    run: typeof entry.run === "number" ? entry.run : 0,
    commit: typeof entry.commit === "string" ? entry.commit : "",
    metric: typeof entry.metric === "number" ? entry.metric : 0,
    metrics: metricMapFrom(entry.metrics),
    status: statusFrom(entry.status),
    description: typeof entry.description === "string" ? entry.description : "",
    ...(typeof entry.title === "string" && entry.title !== "" ? { title: entry.title } : {}),
    ...(typeof entry.summary === "string" && entry.summary !== "" ? { summary: entry.summary } : {}),
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : 0,
    segment,
    confidence: typeof entry.confidence === "number" ? entry.confidence : null,
    asi: asiFrom(entry.asi),
  };
}

function registerSecondaryMetrics(state: ReconstructedState, metrics: Record<string, number>): void {
  for (const name of Object.keys(metrics)) {
    if (state.secondaryMetrics.find((metric) => metric.name === name)) continue;
    state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) });
  }
}

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

export function reconstructState(jsonlContent: string): ReconstructedState {
  const state = reconstructedState();
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
