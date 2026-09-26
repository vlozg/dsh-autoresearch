/**
 * Regression test for the lossless-JSON tool boundary: DSH rejects any tool
 * result carrying an undefined-valued key, which used to brick the loop after
 * every completed run (run_experiment emitted `fullOutputPath: undefined`,
 * `runLogPath: undefined`, `truncation: undefined` on ordinary successful
 * runs). Ops now emit explicit nulls; this drives init → run → log through the
 * real service and asserts every returned value is lossless.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExperimentService, type PluginConfig } from "../src/host/app/experiment-service";
import { lossless } from "../src/host/infra/tools";
import { nodeServiceDeps } from "../src/host/adapters";

let project: string;

const stubCtx = { logger: { warn: () => {}, info: () => {}, error: () => {} } } as never;
const service = new ExperimentService(stubCtx, {
  defaultExperimentTimeoutSeconds: 30,
  defaultChecksTimeoutSeconds: 30,
  autoActivateLoop: true,
} as PluginConfig, nodeServiceDeps());

type ResolveArgs = Parameters<ExperimentService["resolveAgent"]>[0];
const agentStub = (): ResolveArgs =>
  ({ agent: { id: "lossless-1", session: { header: { cwd: project } } } }) as unknown as ResolveArgs;

const freshSignal = () => new AbortController().signal;

/** Walk a value and fail on anything the lossless-JSON boundary would reject. */
const assertLossless = (value: unknown, at = "value"): void => {
  if (value === undefined) throw new Error(`undefined-valued key at ${at}`);
  if (typeof value === "number" && Number.isNaN(value)) throw new Error(`NaN at ${at}`);
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertLossless(v, `${at}[${i}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) assertLossless(v, `${at}.${k}`);
  }
};

const commitSha = () =>
  execSync("git rev-parse --short=7 HEAD", { cwd: project, encoding: "utf-8" }).trim();

beforeAll(() => {
  project = mkdtempSync(path.join(tmpdir(), "ar-lossless-"));
  execSync("git init -q", { cwd: project });
  execSync("mkdir -p .auto src", { cwd: project });
  writeFileSync(path.join(project, "src", "impl.txt"), "100\n");
  // 15 lines of output, well under the 32 KB runner budget: the exact repro —
  // llmTruncation fires (object), but no temp spill file exists, so the old
  // code returned fullOutputPath: undefined.
  writeFileSync(
    path.join(project, ".auto", "measure.sh"),
    "#!/bin/sh\necho METRIC total_us=$(cat src/impl.txt)\n" +
      Array.from({ length: 14 }, (_, i) => `echo "filler diagnostic line ${i + 1}"`).join("\n") +
      "\n",
  );
  writeFileSync(path.join(project, ".auto", "checks.sh"), "#!/bin/sh\nexit 0\n");
  execSync("git add -A && git -c user.name=t -c user.email=t@t commit -q -m seed", { cwd: project });
});

afterAll(() => rmSync(project, { recursive: true, force: true }));

describe("lossless tool results", () => {
  it("strips undefined-valued keys deeply (boundary safety net)", () => {
    expect(lossless({ a: 1, b: undefined, c: { d: undefined, e: 2 }, f: [1, undefined, { g: undefined }] })).toEqual({
      a: 1,
      c: { e: 2 },
      f: [1, null, {}],
    });
    expect(lossless("text")).toBe("text");
    expect(lossless(null)).toBeNull();
  });

  it("init → run → log values survive JSON round-trip with key sets preserved", async () => {
    const runtime = service.resolveAgent(agentStub());
    if ("error" in runtime) throw new Error(runtime.error);

    const init = service.initExperiment(runtime.runtime, {
      name: "Lossless",
      metric_name: "total_us",
      metric_unit: "us",
      direction: "lower",
    } as never);
    assertLossless(init.value, "init.value");

    const run = await service.runExperiment(
      runtime.runtime,
      { command: "bash .auto/measure.sh", timeout_seconds: 30 } as never,
      freshSignal(),
    );
    expect(run.text).toContain("✅ PASSED");
    assertLossless(run.value, "run.value");
    expect(JSON.parse(JSON.stringify(run.value))).toEqual(run.value);
    // The reported failure shape: truncation present, no spill file, run log durable.
    expect(run.value.ok).toBe(true);
    expect(run.value.passed).toBe(true);
    expect(run.value.truncation).not.toBeNull();
    expect((run.value.truncation as { truncatedBy?: unknown }).truncatedBy).toBe("lines");
    expect(run.value.fullOutputPath).toBeNull();
    expect(typeof run.value.runLogPath).toBe("string");
    expect(existsSync(run.value.runLogPath as string)).toBe(true);

    const log = await service.logExperiment(runtime.runtime, {
      commit: commitSha(),
      metric: 100,
      status: "keep",
      description: "baseline impl",
      metrics: { total_us: 100 },
    } as never);
    expect(log.text).toContain("Logged #1: keep");
    assertLossless(log.value, "log.value");
    expect(JSON.parse(JSON.stringify(log.value))).toEqual(log.value);
    expect(log.value.ok).toBe(true);
  });

  it("session snapshot (hook payload) omits goal before init and never emits undefined", () => {
    // A bare project: the main fixture already persisted a name in .auto/config.json.
    const bare = mkdtempSync(path.join(tmpdir(), "ar-lossless-bare-"));
    try {
      execSync("git init -q", { cwd: bare });
      const fresh = service.resolveAgent(
        ({ agent: { id: "lossless-2", session: { header: { cwd: bare } } } }) as unknown as ResolveArgs,
      );
      if ("error" in fresh) throw new Error(fresh.error);
      const preInit = service.sessionSnapshot(fresh.runtime.state, fresh.runtime);
      assertLossless(preInit, "sessionSnapshot(pre-init)");
      expect("goal" in preInit).toBe(false);

      const init = service.initExperiment(fresh.runtime, { name: "Hooked", metric_name: "total_us" } as never);
      assertLossless(init.value, "init.value (second)");
      const postInit = service.sessionSnapshot(fresh.runtime.state, fresh.runtime);
      assertLossless(postInit, "sessionSnapshot(post-init)");
      expect(postInit.goal).toBe("Hooked");
      expect(JSON.parse(JSON.stringify(postInit))).toEqual(postInit);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
