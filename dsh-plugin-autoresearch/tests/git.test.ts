import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitAutoCommit, gitCurrentCommit, gitRevert } from "../src/host/git";

let repo: string;
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const git = (args: string) => execSync(`git ${args}`, { cwd: repo, encoding: "utf-8" });

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "ar-git-"));
  execSync("git init -q", { cwd: repo });
  git("-c user.email=agent@local -c user.name=agent commit --allow-empty -m init");
  writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  execSync("mkdir -p .auto", { cwd: repo });
  writeFileSync(path.join(repo, ".auto/measure.sh"), "#!/bin/sh\necho METRIC x=1\n");
  git("add tracked.txt .auto");
  git("-c user.email=agent@local -c user.name=agent commit -q -m seed");
});

describe("git helpers", () => {
  it("reads the current short commit", async () => {
    const sha = await gitCurrentCommit(repo);
    expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("commits on keep and preserves .auto state", async () => {
    const before = await gitCurrentCommit(repo);
    writeFileSync(path.join(repo, "tracked.txt"), "two\n");
    const r = await gitAutoCommit(repo, "attempt: faster parse", { metric: 42, status: "keep" });
    expect(r.committed).toBe(true);
    expect(r.sha).toMatch(/^[0-9a-f]{7}$/);
    const after = await gitCurrentCommit(repo);
    expect(after).not.toBe(before);
    expect(git("status --porcelain")).toBe("");
    // .auto files are preserved
    expect(require("node:fs").existsSync(path.join(repo, ".auto/measure.sh"))).toBe(true);
  });

  it("reverts untracked noise but preserves .auto files", async () => {
    writeFileSync(path.join(repo, "tracked.txt"), "three\n");
    writeFileSync(path.join(repo, "untracked.txt"), "junk\n");
    writeFileSync(path.join(repo, ".auto/measure.sh"), "#!/bin/sh\necho METRIC x=2\n");
    const r = await gitRevert(repo);
    expect(r.ok).toBe(true);
    expect(require("node:fs").readFileSync(path.join(repo, "tracked.txt"), "utf-8")).toContain("two");
    expect(require("node:fs").existsSync(path.join(repo, "untracked.txt"))).toBe(false);
    expect(require("node:fs").readFileSync(path.join(repo, ".auto/measure.sh"), "utf-8")).toContain("x=2");
  });

  it("is safe outside a git repository", async () => {
    const bare = mkdtempSync(path.join(tmpdir(), "ar-nogit-"));
    const r = await gitRevert(bare);
    expect(r.ok).toBe(false);
    rmSync(bare, { recursive: true, force: true });
  });
});
