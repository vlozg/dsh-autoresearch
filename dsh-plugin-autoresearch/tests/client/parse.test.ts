import { describe, expect, it } from "vitest";
import { parseInitText, parseLogText, parseRunText } from "../../src/client/entities/parse";

const RUN_PASSED = [
  "✅ PASSED in 3.2s",
  "✅ Checks passed in 0.4s",
  "📊 Current best total_us: 80.0us",
  "",
  "📐 Parsed metrics: ★ total_us=75.3us size_kb=2us",
  "Use these values directly in log_experiment (metric: 75.3, metrics: {\"size_kb\": 2})",
  "",
  "compiling src...",
  "METRIC total_us=75.3",
  "",
  "[Showing last 200 of 400 lines.",
].join("\n");

const RUN_FAILED = [
  "💥 FAILED (exit code 1) in 0.8s",
  "",
  "traceback line 1",
  "traceback line 2",
].join("\n");

describe("parseRunText", () => {
  it("extracts status, duration, parsed metrics, and tail", () => {
    const model = parseRunText(RUN_PASSED);
    expect(model.kind).toBe("passed");
    expect(model.durationSeconds).toBeCloseTo(3.2);
    expect(model.primaryName).toBe("total_us");
    expect(model.parsed).toEqual([
      { name: "total_us", value: 75.3 },
      { name: "size_kb", value: 2 },
    ]);
    expect(model.bestLine).toBe("📊 Current best total_us: 80.0us");
    expect(model.tail).toContain("METRIC total_us=75.3");
    expect(model.tail).toContain("[Showing last 200 of 400 lines.");
    expect(model.truncated).toBe(true);
  });

  it("classifies failures with exit codes", () => {
    const model = parseRunText(RUN_FAILED);
    expect(model.kind).toBe("failed");
    expect(model.exitCode).toBe(1);
    expect(model.durationSeconds).toBeCloseTo(0.8);
    expect(model.tail).toContain("traceback line 2");
  });

  it("classifies timeouts, aborts, and checks variants", () => {
    expect(parseRunText("⏰ TIMEOUT after 30.0s\n\nout").kind).toBe("timeout");
    expect(parseRunText("🛑 Experiment aborted after 4.0s\n\nout").kind).toBe("aborted");
    expect(parseRunText("✅ Benchmark PASSED in 1.0s\n💥 CHECKS FAILED (.auto/checks.sh) in 0.2s\n\nx").kind).toBe("checks_failed");
    expect(parseRunText("✅ Benchmark PASSED in 1.0s\n⏰ CHECKS TIMEOUT (.auto/checks.sh) after 5.0s\n\nx").kind).toBe("checks_timeout");
  });
});

const LOG_KEEP = [
  "Logged #3: keep — switch parser to single pass",
  "Baseline total_us: 80.0us | this: 75.3us (-5.9%)",
  "Secondary: size_kb: 2kb (+0.0%)",
  "📊 Confidence: 3.2× noise floor — improvement is likely real",
  "(3 experiments / 10 max)",
  "📝 Git: committed — abcd1234",
].join("\n");

const LOG_DISCARD = [
  "Logged #4: discard — slower variant",
  "Baseline total_us: 75.3us | this: 90.0us (+19.5%)",
  "(4 experiments)",
  "📝 Git: reverted changes (discard) — autoresearch files preserved",
].join("\n");

describe("parseLogText", () => {
  it("parses keep verdicts with delta and confidence", () => {
    const model = parseLogText(LOG_KEEP);
    expect(model.status).toBe("keep");
    expect(model.run).toBe(3);
    expect(model.description).toBe("switch parser to single pass");
    expect(model.deltaLine).toBe("75.3us (-5.9%)");
    expect(model.confidence).toBeCloseTo(3.2);
    expect(model.gitLine).toContain("abcd1234");
    expect(model.segmentLine).toBe("(3 experiments / 10 max)");
    expect(model.limitReached).toBe(false);
  });

  it("parses discards and the segment limit", () => {
    const model = parseLogText(LOG_DISCARD + "\n\n🛑 Maximum experiments reached (4). STOP the experiment loop now.");
    expect(model.status).toBe("discard");
    expect(model.confidence).toBeNull();
    expect(model.limitReached).toBe(true);
  });
});

describe("parseInitText", () => {
  it("parses success and failure texts", () => {
    expect(parseInitText('✅ Experiment session initialized: "speed up parse"')).toEqual({
      ok: true,
      name: "speed up parse",
      error: null,
    });
    const failure = parseInitText("❌ An experiment is already running (bash .auto/measure.sh).");
    expect(failure.ok).toBe(false);
    expect(failure.error).toContain("already running");
  });
});
