import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { truncateTail } from "../src/host/adapters/truncate";
import { createTempFileAllocator, runCommand } from "../src/host/adapters/child-runner";

const workDir = mkdtempSync(path.join(tmpdir(), "ar-run-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("runCommand", () => {
  it("captures stdout+stderr and the exit code", async () => {
    const r = await runCommand({
      workDir,
      command: "echo out; echo err >&2; exit 3",
      timeoutMs: 10_000,
      maxLines: 40,
      maxBytes: 32 * 1024,
    });
    expect(r.exitCode).toBe(3);
    expect(r.killed).toBe(false);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
    expect(r.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it("marks timeout kills", async () => {
    const r = await runCommand({
      workDir,
      command: "sleep 5",
      timeoutMs: 300,
      maxLines: 40,
      maxBytes: 32 * 1024,
    });
    expect(r.killed).toBe(true);
    expect(r.durationSeconds).toBeLessThan(5);
  });

  it("aborts through the caller signal", async () => {
    const controller = new AbortController();
    const pending = runCommand({
      workDir,
      command: "sleep 5",
      timeoutMs: 30_000,
      signal: controller.signal,
      maxLines: 40,
      maxBytes: 32 * 1024,
    });
    setTimeout(() => controller.abort(), 250);
    const r = await pending;
    expect(r.killed).toBe(true);
  });

  it("captures full output; truncation is caller-side", async () => {
    const r = await runCommand({
      workDir,
      command: "seq 1 100",
      timeoutMs: 10_000,
      maxLines: 10,
      maxBytes: 32 * 1024,
    });
    expect(r.output.trimEnd().endsWith("100")).toBe(true);
    const tail = truncateTail(r.output, { maxLines: 10, maxBytes: 32 * 1024 });
    expect(tail.truncated).toBe(true);
    expect(tail.outputLines).toBe(10);
  });
});

describe("createTempFileAllocator", () => {
  it("allocates lazily and reuses one path", () => {
    const alloc = createTempFileAllocator("ar-alloc");
    const a = alloc();
    expect(alloc()).toBe(a);
    expect(a).toContain("ar-alloc-");
  });
});
