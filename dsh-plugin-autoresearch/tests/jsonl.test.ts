import { describe, expect, it } from "vitest";
import {
  extractSessionName,
  hasConfigHeader,
  inferMetricUnit,
  reconstructState,
  serializeEntry,
  type ConfigHeader,
} from "../src/host/jsonl";

const config = (overrides: Partial<ConfigHeader> = {}): ConfigHeader => ({
  type: "config",
  name: "Optimizing liquid",
  metricName: "total_µs",
  metricUnit: "µs",
  bestDirection: "lower",
  ...overrides,
});

const run = (n: number, metric: number, status: ConfigHeader extends never ? never : "keep" | "discard" | "crash" | "checks_failed", extra: Record<string, unknown> = {}) => ({
  run: n,
  commit: "abc1234",
  metric,
  metrics: {},
  status,
  description: `run ${n}`,
  timestamp: 1700000000000 + n,
  ...extra,
});

describe("inferMetricUnit", () => {
  it("maps suffixes to units", () => {
    expect(inferMetricUnit("compile_µs")).toBe("µs");
    expect(inferMetricUnit("parse_ms")).toBe("ms");
    expect(inferMetricUnit("load_s")).toBe("s");
    expect(inferMetricUnit("size_kb")).toBe("kb");
    expect(inferMetricUnit("score")).toBe("");
  });
});

describe("reconstructState", () => {
  it("returns defaults for an empty log", () => {
    const state = reconstructState("");
    expect(state.name).toBeNull();
    expect(state.metricName).toBe("metric");
    expect(state.bestDirection).toBe("lower");
    expect(state.currentSegment).toBe(0);
    expect(state.results).toEqual([]);
  });

  it("applies the config header", () => {
    const state = reconstructState(JSON.stringify(config()) + "\n");
    expect(state.name).toBe("Optimizing liquid");
    expect(state.metricName).toBe("total_µs");
    expect(state.metricUnit).toBe("µs");
    expect(state.bestDirection).toBe("lower");
    expect(state.currentSegment).toBe(0); // no results yet → segment stays 0
  });

  it("binds runs to the segment they follow and bumps the segment on re-init", () => {
    const jsonl = [
      JSON.stringify(config()),
      JSON.stringify(run(1, 100, "keep")),
      JSON.stringify(config({ name: "Round two" })),
      JSON.stringify(run(2, 90, "keep")),
    ].join("\n");
    const state = reconstructState(jsonl);
    expect(state.currentSegment).toBe(1);
    expect(state.results[0].segment).toBe(0);
    expect(state.results[1].segment).toBe(1);
    expect(state.name).toBe("Round two");
  });

  it("clears secondary metric definitions on a new segment", () => {
    const jsonl = [
      JSON.stringify(config()),
      JSON.stringify(run(1, 100, "keep", { metrics: { parse_ms: 4 } })),
      JSON.stringify(config()),
      JSON.stringify(run(2, 90, "keep", { metrics: { other_s: 2 } })),
    ].join("\n");
    const state = reconstructState(jsonl);
    expect(state.secondaryMetrics.map((m) => m.name)).toEqual(["other_s"]);
  });

  it("tolerates malformed lines", () => {
    const state = reconstructState("not json\n" + JSON.stringify(config()) + "\n[1,2]\n");
    expect(state.name).toBe("Optimizing liquid");
  });
});

describe("hasConfigHeader / extractSessionName", () => {
  it("detects and extracts", () => {
    expect(hasConfigHeader(JSON.stringify(config()))).toBe(true);
    expect(hasConfigHeader(JSON.stringify(run(1, 1, "keep")))).toBe(false);
    expect(extractSessionName(JSON.stringify(config({ name: "Name" })))).toBe("Name");
    expect(extractSessionName("")).toBe("Autoresearch");
  });
});

describe("serializeEntry", () => {
  it("produces one JSON line", () => {
    expect(serializeEntry({ a: 1 })).toBe('{"a":1}');
  });
});
