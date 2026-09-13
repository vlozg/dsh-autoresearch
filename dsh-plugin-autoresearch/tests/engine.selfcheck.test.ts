/**
 * Headless end-to-end selfcheck of the autoresearch engine against a dummy
 * benchmark project — the pi-autoresearch loop without an LLM in the middle:
 *   init_experiment → run_experiment (measure.sh) → log_experiment (keep/discard)
 *   → jsonl persistence → reconstruct-from-log (auto-activate, segment bump)
 *   → max-limit stop.
 */
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ExperimentService,
  type PluginConfig,
  type SessionRuntime,
} from "../src/host/experiment";
import { sessionFilePath } from "../src/host/adapters/fs-log-store";
import { nodeServiceDeps } from "../src/host/adapters";

let project: string;
const seen: string[] = [];

const stubCtx = { logger: { warn: () => {}, info: () => {}, error: () => {} } } as never;
const service = new ExperimentService(stubCtx, {
  defaultExperimentTimeoutSeconds: 30,
  defaultChecksTimeoutSeconds: 30,
  autoActivateLoop: true,
} as PluginConfig, nodeServiceDeps());

type ResolveArgs = Parameters<ExperimentService["resolveAgent"]>[0];
const agentStub = (id: string): ResolveArgs =>
  ({ agent: { id, session: { header: { cwd: project } } } }) as unknown as ResolveArgs;

const runtimeOf = (id: string): SessionRuntime => {
  const resolved = service.resolveAgent(agentStub(id));
  if ("error" in resolved) throw new Error(resolved.error);
  return resolved.runtime;
};

const freshSignal = () => new AbortController().signal;

const expectRunCount = (dir: string, count: number) => {
  const log = readFileSync(sessionFilePath(dir, "log"), "utf-8");
  const lines = log.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { run?: number });
  expect(lines.filter((e) => typeof e.run === "number").length).toBe(count);
};

const commitSha = () =>
  execSync("git rev-parse --short=7 HEAD", { cwd: project, encoding: "utf-8" }).trim();

beforeAll(() => {
  project = mkdtempSync(path.join(tmpdir(), "ar-selfcheck-"));
  execSync("git init -q", { cwd: project });
  execSync("mkdir -p .auto src", { cwd: project });
  writeFileSync(path.join(project, "src", "impl.txt"), "100\n");
  writeFileSync(
    path.join(project, ".auto", "measure.sh"),
    "#!/bin/sh\necho METRIC total_us=$(cat src/impl.txt)\necho METRIC size_kb=2\n",
  );
  writeFileSync(path.join(project, ".auto", "checks.sh"), "#!/bin/sh\nexit 0\n");
  execSync("git add -A && git -c user.name=t -c user.email=t@t commit -q -m seed", { cwd: project });
});

afterAll(() => rmSync(project, { recursive: true, force: true }));

describe("engine selfcheck (headless loop)", () => {
  it("drives init → run → log → keep / discard with git commit+revert", async () => {
    service.subscribe((e) => seen.push(e.kind));
    const runtime = runtimeOf("selfcheck-1");

    const init = service.initExperiment(runtime, {
      name: "Selfcheck",
      metric_name: "total_us",
      metric_unit: "us",
      direction: "lower",
    } as never);
    expect(init.text).toContain("initialized");
    expect(service.getRuntime("selfcheck-1")?.loop).toBe(true);

    const run1 = await service.runExperiment(
      runtime,
      { command: "bash .auto/measure.sh", timeout_seconds: 30 } as never,
      freshSignal(),
    );
    expect(run1.text).toContain("✅ PASSED");
    expect(run1.value.parsedPrimary).toBe(100);
    expect(run1.value.passed).toBe(true);

    const log1 = await service.logExperiment(runtime, {
      commit: commitSha(),
      metric: 100,
      status: "keep",
      description: "baseline impl",
      metrics: { total_us: 100, size_kb: 2 },
    } as never);
    expect(log1.text).toContain("Logged #1: keep");
    expect(log1.text).toContain("📝 Git: committed");
    expectRunCount(project, 1);

    writeFileSync(path.join(project, "src", "impl.txt"), "80\n");
    const run2 = await service.runExperiment(runtime, { command: "bash .auto/measure.sh" } as never, freshSignal());
    expect(run2.value.parsedPrimary).toBe(80);
    const log2 = await service.logExperiment(runtime, {
      commit: commitSha(),
      metric: 80,
      status: "keep",
      description: "cut to 80",
      metrics: { total_us: 80, size_kb: 2 },
    } as never);
    expect(log2.text).toContain("Logged #2: keep");
    expect(log2.text).toContain("this: 80us");

    writeFileSync(path.join(project, "src", "impl.txt"), "999\n");
    await service.runExperiment(runtime, { command: "bash .auto/measure.sh" } as never, freshSignal());
    const log3 = await service.logExperiment(runtime, {
      commit: commitSha(),
      metric: 999,
      status: "discard",
      description: "regression, discard",
      metrics: { total_us: 999, size_kb: 2 },
    } as never);
    expect(log3.text).toContain("Logged #3: discard");
    expect(log3.text).toContain("📝 Git: reverted");
    const implAfter = readFileSync(path.join(project, "src", "impl.txt"), "utf-8").trim();
    expect(implAfter).toBe("80"); // reverted to the keep state

    expect(seen.filter((k) => k === "state").length).toBeGreaterThanOrEqual(3);
  });

  it("reconstructs from log.jsonl with auto-activated loop; re-init bumps the segment", () => {
    const runtime = runtimeOf("selfcheck-2");
    expect(runtime.loop).toBe(true); // log exists + same cwd → auto-activate
    expect(runtime.experimentsThisSession).toBe(0);
    const reInit = service.initExperiment(runtime, {
      name: "Selfcheck round 2",
      metric_name: "total_us",
      metric_unit: "us",
      direction: "lower",
    } as never);
    expect(reInit.text).toContain("initialized");
    expect(runtime.state.currentSegment).toBe(1);
  });

  it("stops the loop at the max-experiments limit", async () => {
    const runtime = runtimeOf("selfcheck-3");
    runtime.maxExperiments = 2; // limit counts per segment; segment 1 is empty → stops on the 2nd log
    for (let i = 0; i < 2; i++) {
      writeFileSync(path.join(project, "src", "impl.txt"), String(50 + i) + "\n");
      await service.runExperiment(runtime, { command: "bash .auto/measure.sh" } as never, freshSignal());
      const log = await service.logExperiment(runtime, {
        commit: commitSha(),
        metric: 50 + i,
        status: i === 0 ? "keep" : "discard",
        description: "run " + String(i + 4),
        metrics: { total_us: 50 + i },
      } as never);
      if (i === 0) expect(log.text).not.toContain("🛑");
      else expect(log.text).toContain("🛑 Maximum experiments reached");
    }
    expect(runtime.loop).toBe(false);
  });

  it("measure.sh guard rejects non-benchmark commands; env-wrapped command passes", async () => {
    const runtime = runtimeOf("selfcheck-4");
    const blocked = await service.runExperiment(runtime, { command: "echo hello" } as never, freshSignal());
    expect(blocked.text).toContain("measure.sh");
    const okWrap = await service.runExperiment(runtime, { command: "NO_COLOR=1 bash .auto/measure.sh" } as never, freshSignal());
    expect(okWrap.value.passed).toBe(true);
  });
});