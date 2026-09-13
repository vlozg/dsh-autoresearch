import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ExperimentService, type PluginConfig } from "../src/host/experiment";
import { byRecency, findAutoWorkdirs, summarizeWorkdir, type DetectedSession } from "../src/host/detect";
import type { Agent } from "@deepseek-ai/dsh-agent";

const CONFIG: PluginConfig = {
  defaultExperimentTimeoutSeconds: 600,
  defaultChecksTimeoutSeconds: 300,
  autoActivateLoop: true,
};

function writeLog(workDir: string, lines: unknown[]): void {
  fs.mkdirSync(path.join(workDir, ".auto"), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, ".auto", "log.jsonl"),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf-8",
  );
}

function configHeader(name: string): unknown {
  return { type: "config", name, metricName: "total_ms", metricUnit: "ms", bestDirection: "lower" };
}

function runEntry(run: number, metric: number, timestamp: number): unknown {
  return { run, commit: "abc1234", metric, metrics: { total_ms: metric }, status: "keep", description: "r" + run, timestamp, confidence: 1 };
}

function fakeAgent(id: string, cwd: string): Agent {
  return { id, session: { header: { cwd } } } as unknown as Agent;
}

describe("findAutoWorkdirs", () => {
  it("finds .auto/log.jsonl within depth, skipping hidden and dependency dirs", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ar-find-")));
    const projA = path.join(root, "projA");
    const nested = path.join(root, "projB", "nested");
    const deep = path.join(root, "projD", "a", "b");
    writeLog(projA, [configHeader("A")]);
    writeLog(path.join(root, "projB", "node_modules", "pkg"), [configHeader("skipme")]);
    writeLog(nested, [configHeader("B")]);
    writeLog(deep, [configHeader("deep")]);
    fs.mkdirSync(path.join(root, "projC", ".auto"), { recursive: true });

    const found = findAutoWorkdirs(root).map((dir) => path.relative(root, dir)).sort();
    expect(found).toEqual(["projA", "projB/nested"]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("respects a custom depth", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ar-depth-")));
    writeLog(path.join(root, "projA"), [configHeader("A")]);
    expect(findAutoWorkdirs(root, 0)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("summarizeWorkdir", () => {
  it("summarizes a session log", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ar-sum-")));
    const workDir = path.join(root, "proj");
    writeLog(workDir, [configHeader("Tuning"), runEntry(1, 100, 1000), runEntry(2, 90, 2000)]);
    const summary = summarizeWorkdir(workDir);
    expect(summary).toEqual({
      sessionId: null,
      workDir,
      name: "Tuning",
      metricName: "total_ms",
      metricUnit: "ms",
      bestDirection: "lower",
      currentSegment: 0,
      runs: 2,
      bestMetric: 90,
      lastTimestamp: 2000,
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns null for a missing or empty log", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ar-empty-")));
    expect(summarizeWorkdir(root)).toBeNull();
    fs.mkdirSync(path.join(root, ".auto"), { recursive: true });
    fs.writeFileSync(path.join(root, ".auto", "log.jsonl"), "", "utf-8");
    expect(summarizeWorkdir(root)).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("ExperimentService.detect", () => {
  it("attaches matching workdirs and lists the rest", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ar-detect-")));
    const ws = path.join(tmp, "ws");
    const projA = path.join(ws, "projA");
    const projB = path.join(ws, "projB", "nested");
    writeLog(projA, [configHeader("Alpha"), runEntry(1, 50, 500)]);
    writeLog(projB, [configHeader("Beta"), runEntry(1, 20, 900), runEntry(2, 10, 1500)]);
    const agentIdle = fakeAgent("idle", ws);
    const agentA = fakeAgent("a2", projA);
    const service = new ExperimentService(
      { agents: { list: () => [agentIdle, agentA], get: (id: string) => (id === "a2" ? agentA : id === "idle" ? agentIdle : undefined) } } as never,
      CONFIG,
    );

    const result = service.detect();

    // projA matches agent a2's resolved workdir: attached + runtime created.
    expect(result.attached).toHaveLength(1);
    expect(result.attached[0]).toMatchObject({ sessionId: "a2", workDir: projA, name: "Alpha", runs: 1 });
    const snapshots = service.listSnapshots();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].sessionId).toBe("a2");
    // Loop auto-armed by the pre-existing log (pi parity).
    expect(snapshots[0].loop).toBe(true);

    // The sibling nested project has no live conversation: unattached.
    expect(result.unattached).toHaveLength(1);
    expect(result.unattached[0]).toMatchObject({ workDir: projB, name: "Beta", runs: 2, bestMetric: 10 });
    expect(result.unattached[0].sessionId).toBeNull();

    // Scoping: one conversation's cwd only.
    const scoped = service.detect("a2");
    expect(scoped.attached).toHaveLength(1);
    expect(scoped.unattached).toHaveLength(0);
    const unknown = service.detect("missing");
    expect(unknown.attached).toHaveLength(0);
    expect(unknown.unattached).toHaveLength(0);

    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reports nothing when no conversation has an autoresearch workdir", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ar-none-")));
    const service = new ExperimentService({ agents: { list: () => [fakeAgent("solo", tmp)] } } as never, CONFIG);
    const result = service.detect();
    expect(result.attached).toEqual([]);
    expect(result.unattached).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe("byRecency", () => {
  it("sorts newest first, runless sessions last", () => {
    const a: DetectedSession = { sessionId: null, workDir: "/a", name: "a", metricName: "m", metricUnit: "", bestDirection: "lower", currentSegment: 0, runs: 1, bestMetric: 1, lastTimestamp: 100 };
    const b: DetectedSession = { sessionId: null, workDir: "/b", name: "b", metricName: "m", metricUnit: "", bestDirection: "lower", currentSegment: 0, runs: 1, bestMetric: 1, lastTimestamp: 200 };
    const none: DetectedSession = { ...a, workDir: "/n", lastTimestamp: null };
    expect([a, b].sort(byRecency).map((s) => s.workDir)).toEqual(["/b", "/a"]);
    expect([none, a].sort(byRecency).map((s) => s.workDir)).toEqual(["/a", "/n"]);
  });
});
