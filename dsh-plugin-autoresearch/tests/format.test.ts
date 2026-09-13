import { describe, expect, it } from "vitest";
import { splitRunText } from "../src/client/shared/format";

describe("splitRunText", () => {
  it("splits on the recommended title: finding form", () => {
    const parts = splitRunText("Merge same-family titles: precision regressed after low-attribute rows left the pool");
    expect(parts.title).toBe("Merge same-family titles");
    expect(parts.finding).toBe("precision regressed after low-attribute rows left the pool");
  });

  it("keeps short descriptions whole", () => {
    expect(splitRunText("v42: homestead merges")).toEqual({ title: "v42: homestead merges", finding: "" });
  });

  it("falls back to a word-boundary cut for long free text", () => {
    const long = "v45: +Cell Phone Bill (Signal Wireless/Sarah Chen), +Internet (Sarah Chen), +Home Security, +Streaming TV bundle consolidation across 13 candidate merges with mixed precision outcomes";
    const parts = splitRunText(long);
    expect(parts.title.length).toBeLessThanOrEqual(72);
    expect(long.startsWith(parts.title)).toBe(true);
    expect(parts.finding.length).toBeGreaterThan(0);
    expect(parts.finding).not.toMatch(/^[\s,;:\u2013\u2014-]/);
  });

  it("treats a colon deep in the text as prose, not a title split", () => {
    const parts = splitRunText("Tried the wide merge first, then the narrow one: narrow won but stayed under the noise floor for three straight runs in this segment");
    expect(parts.title.length).toBeLessThanOrEqual(72);
    expect(parts.finding.length).toBeGreaterThan(0);
  });
});
