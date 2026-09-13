import { describe, expect, it } from "vitest";
import {
  computeConfidence,
  countConsecutiveDiscardOrCrashResults,
  currentResults,
  findBaselineMetric,
  findBaselineSecondary,
  formatElapsed,
  formatNum,
  isBetter,
  parseMetricLines,
  sortedMedian,
} from "../src/host/domain/metrics";
import type { RunEntry } from "../src/host/domain/model";

const entry = (partial: Partial<RunEntry>): RunEntry => ({
  run: 1,
  commit: "abc1234",
  metric: 10,
  metrics: {},
  status: "keep",
  description: "d",
  timestamp: 0,
  segment: 0,
  confidence: null,
  ...partial,
});

describe("parseMetricLines", () => {
  it("parses METRIC name=value lines, last wins", () => {
    const map = parseMetricLines("noise\nMETRIC total_us=1234\nMETRIC total_us=1200\nMETRIC junk!@#=x\nMETRIC bad=nan\n");
    expect(map.get("total_us")).toBe(1200);
    expect(map.has("junk!@#")).toBe(false);
    expect(map.has("bad")).toBe(false);
  });
});

describe("isBetter", () => {
  it("respects direction", () => {
    expect(isBetter(5, 10, "lower")).toBe(true);
    expect(isBetter(15, 10, "lower")).toBe(false);
    expect(isBetter(15, 10, "higher")).toBe(true);
  });
});

describe("sortedMedian", () => {
  it("median of odd/even", () => {
    expect(sortedMedian([3, 1, 2])).toBe(2);
    expect(sortedMedian([4, 1, 2, 3])).toBe(2.5);
    expect(sortedMedian([])).toBe(0);
  });
});

describe("segment helpers", () => {
  it("filters by segment and finds the baseline", () => {
    const results = [entry({ run: 1, segment: 0, metric: 100 }), entry({ run: 2, segment: 1, metric: 90 })];
    expect(currentResults(results, 1)).toEqual([results[1]]);
    expect(findBaselineMetric(results, 1)).toBe(90);
    expect(findBaselineMetric(results, 7)).toBeNull();
  });

  it("finds per-name secondary baselines", () => {
    const results = [
      entry({ run: 1, metrics: { parse_ms: 4, size_kb: 10 } }),
      entry({ run: 2, metrics: { parse_ms: 3 } }),
    ];
    const baselines = findBaselineSecondary(results, 0, [
      { name: "parse_ms" },
      { name: "size_kb" },
      { name: "absent" },
    ]);
    expect(baselines).toEqual({ parse_ms: 4, size_kb: 10, absent: undefined });
  });

  it("counts trailing discard/crash runs in the current segment", () => {
    const results = [
      entry({ run: 1, status: "keep" }),
      entry({ run: 2, status: "discard" }),
      entry({ run: 3, status: "crash" }),
    ];
    expect(countConsecutiveDiscardOrCrashResults(results, 0)).toBe(2);
    expect(countConsecutiveDiscardOrCrashResults([entry({ run: 1, status: "keep" })], 0)).toBe(0);
  });
});

describe("computeConfidence", () => {
  it("returns null below 3 points", () => {
    const results = [entry({ metric: 10 }), entry({ metric: 9 })];
    expect(computeConfidence(results, 0, "lower")).toBeNull();
  });

  it("returns null when MAD is 0", () => {
    const results = [entry({ metric: 10 }), entry({ metric: 10 }), entry({ metric: 10 })];
    expect(computeConfidence(results, 0, "lower")).toBeNull();
  });

  it("returns null without a kept improvement", () => {
    const results = [
      entry({ metric: 10 }),
      entry({ metric: 9, status: "discard" }),
      entry({ metric: 11, status: "discard" }),
    ];
    expect(computeConfidence(results, 0, "lower")).toBeNull();
  });

  it("scores kept improvement as a multiple of the noise floor", () => {
    const results = [
      entry({ metric: 10 }),
      entry({ metric: 10.4 }),
      entry({ metric: 9.6 }),
      entry({ run: 4, metric: 9, status: "keep" }),
    ];
    // values [10, 10.4, 9.6, 9]; median 9.8; deviations [0.2,0.6,0.2,0.8]; mad 0.4
    const confidence = computeConfidence(results, 0, "lower");
    expect(confidence).toBeCloseTo(Math.abs(9 - 10) / 0.4, 5);
  });
});

describe("formatting", () => {
  it("formats numbers with units", () => {
    expect(formatNum(1234, "µs")).toBe("1234µs");
    expect(formatNum(1.2345, "s")).toBe("1.23s");
    expect(formatNum(null, "")).toBe("—");
  });

  it("formats elapsed", () => {
    expect(formatElapsed(5300)).toBe("5s");
    expect(formatElapsed(65000)).toBe("1m 05s");
  });

  it("formats sizes", () => {
    expect(formatNum(0, "")).toBe("0");
  });
});
