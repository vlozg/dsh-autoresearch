import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  autoDir,
  canonicalPath,
  readConfig,
  runLogPath,
  samePath,
  sessionFilePath,
  validateWorkDir,
} from "../src/host/paths";

let dir: string;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("paths", () => {
  it("lays out the .auto tree", () => {
    expect(autoDir("/w")).toBe("/w/.auto");
    expect(sessionFilePath("/w", "log")).toBe("/w/.auto/log.jsonl");
    expect(sessionFilePath("/w", "measure")).toBe("/w/.auto/measure.sh");
    expect(runLogPath("/w", 7)).toBe("/w/.auto/runs/7.log");
  });

  it("normalizes and compares paths", () => {
    expect(samePath("/a/b/", "/a/b")).toBe(true);
    expect(samePath("/a/b", "/a/c")).toBe(false);
    expect(canonicalPath("/x/../y")).toBe("/y");
  });

  it("validates work dirs", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ar-paths-"));
    expect(validateWorkDir(dir)).toBeNull();
    expect(validateWorkDir(path.join(tmpdir(), "missing-dir-zz"))).not.toBeNull();
  });

  it("reads .auto/config.json", () => {
    dir = mkdtempSync(path.join(tmpdir(), "ar-paths2-"));
    execSync("mkdir -p .auto", { cwd: dir });
    writeFileSync(path.join(dir, ".auto/config.json"), '{"maxIterations": 50}');
    expect(readConfig(dir)).toEqual({ maxIterations: 50 });
    expect(readConfig(path.join(tmpdir(), "empty-zz"))).toEqual({});
  });
});
