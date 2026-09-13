import { describe, expect, it } from "vitest";
import { bestDelta, loopState, sessionSubtitle } from "../../src/client/derive";
import type { ExperimentSnapshot, RunEntry } from "../../src/client/store";

const run = (n: number, metric: number, status: RunEntry["status"], segment: number, ts: number): RunEntry => ({
  run: n, commit: "abcd1234", metric, metrics: {}, status, description: "d", timestamp: ts, segment, confidence: null,
});

const snap = (overrides: Partial<ExperimentSnapshot> = {}): ExperimentSnapshot => ({
  sessionId: "s1",
  workDir: "/tmp/demo",
  name: "demo",
  metricName: "total_us",
  metricUnit: "us",
  bestDirection: "lower",
  metricLabel: null,
  objectiveLabel: null,
  currentSegment: 1,
  maxExperiments: null,
  baseline: 100,
  bestMetric: 80,
  confidence: 2.5,
  runs: [],
  secondaryMetrics: [],
  running: null,
  loop: false,
  loopStopReason: null,
  experimentsThisSession: 1,
  autoResumeTurns: 3,
  ...overrides,
});

describe("bestDelta", () => {
  it("measures against the best earlier keep in the same segment", () => {
    const s = snap({ runs: [run(1, 0.9, "keep", 1, 10), run(2, 0.461, "keep", 1, 20)] });
    expect(bestDelta(s, s.runs[1])).toEqual({ label: "\u221248.8% better", good: true });
  });

  it("reports a worse run with a positive label", () => {
    const s = snap({ runs: [run(1, 0.9, "keep", 1, 10), run(2, 0.99, "discard", 1, 20)] });
    expect(bestDelta(s, s.runs[1])).toEqual({ label: "+10.0% worse", good: false });
  });

  it("ignores keeps from other segments (mixed-metric sessions)", () => {
    const s = snap({ runs: [run(1, 0.5, "keep", 0, 10), run(2, 0.9, "keep", 1, 20)] });
    expect(bestDelta(s, s.runs[1])).toBeNull();
  });

  it("returns null for a non-finite or non-positive metric", () => {
    const s = snap({ runs: [run(1, 0.9, "keep", 1, 10), run(2, 0, "crash", 1, 20)] });
    expect(bestDelta(s, s.runs[1])).toBeNull();
  });
});

describe("loopState", () => {
  it("reflects the running phase", () => {
    expect(loopState(snap({ running: { command: "bash", startedAt: 1, phase: "running" } }))).toEqual({ state: "running", label: "running" });
    expect(loopState(snap({ running: { command: "bash", startedAt: 1, phase: "checks" } }))).toEqual({ state: "running", label: "checking" });
  });

  it("reflects loop mode, stop reason, and idle", () => {
    expect(loopState(snap({ loop: true }))).toEqual({ state: "live", label: "loop on" });
    expect(loopState(snap({ loopStopReason: "stopped from dashboard" }))).toEqual({ state: "idle", label: "loop off" });
    expect(loopState(snap({}))).toEqual({ state: "off", label: "idle" });
  });
});

describe("sessionSubtitle", () => {
  it("joins workdir, metric label, segment, and stop reason", () => {
    const s = snap({ metricLabel: "Attribute precision", loopStopReason: "max experiments reached" });
    expect(sessionSubtitle(s, 1000)).toBe("demo \u00b7 Attribute precision \u00b7 Segment 1 \u00b7 max experiments reached");
  });

  it("falls back to the metric name and mentions updates", () => {
    const s = snap({ runs: [run(1, 0.9, "keep", 1, 1000)] });
    expect(sessionSubtitle(s, 61000)).toContain("demo \u00b7 total_us \u00b7 Segment 1 \u00b7 updated");
  });
});