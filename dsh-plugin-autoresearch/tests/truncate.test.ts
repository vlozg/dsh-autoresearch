import { describe, expect, it } from "vitest";
import { formatSize, truncateAtBoundary, truncateTail } from "../src/host/truncate";

describe("truncateTail", () => {
  it("keeps short output as-is", () => {
    const r = truncateTail("a\nb\nc", { maxLines: 5, maxBytes: 100 });
    expect(r.content).toBe("a\nb\nc");
    expect(r.truncated).toBe(false);
    expect(r.totalLines).toBe(3);
    expect(r.outputLines).toBe(3);
  });

  it("clips to the last N lines", () => {
    const r = truncateTail("1\n2\n3\n4\n5", { maxLines: 2, maxBytes: 1000 });
    expect(r.content).toBe("4\n5");
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("lines");
    expect(r.outputLines).toBe(2);
  });

  it("clips to a byte boundary on whole lines", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}-xxxxxxxx`);
    const r = truncateTail(lines.join("\n"), { maxLines: 100, maxBytes: 30 });
    expect(Buffer.byteLength(r.content, "utf-8")).toBeLessThanOrEqual(30);
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe("bytes");
    expect(r.content.endsWith("line-9-xxxxxxxx")).toBe(true);
  });

  it("counts empty text as zero lines", () => {
    const r = truncateTail("", { maxLines: 5, maxBytes: 100 });
    expect(r.totalLines).toBe(0);
    expect(r.truncated).toBe(false);
  });
});

describe("formatSize", () => {
  it("formats bytes", () => {
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(2048)).toBe("2.0KB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0MB");
  });
});
