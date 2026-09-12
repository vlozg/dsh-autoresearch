/**
 * Output truncation utilities. Tail-keeping truncation mirrors the
 * pi-coding-agent helpers the original extension imports.
 */

export interface TruncateOptions {
  maxLines: number;
  maxBytes: number;
}

export interface TruncateResult {
  content: string;
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  outputLines: number;
  totalLines: number;
}

/** Byte length of a UTF-8 encoded string. */
function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

/**
 * Keep the tail of the output: first clip to the last maxLines lines, then
 * (if still too big) to a whole-line boundary within maxBytes. The "lines"
 * answer wins when both limits were hit by the line cut.
 */
export function truncateTail(text: string, options: TruncateOptions): TruncateResult {
  const totalLines = text === "" ? 0 : text.split("\n").length;
  let content = text;
  let truncated = false;
  let truncatedBy: "lines" | "bytes" | undefined;

  if (totalLines > options.maxLines) {
    const lines = content.split("\n");
    content = lines.slice(lines.length - options.maxLines).join("\n");
    truncated = true;
    truncatedBy = "lines";
  }

  if (byteLength(content) > options.maxBytes) {
    // Walk lines from the end until the budget is exhausted.
    const lines = content.split("\n");
    const kept: string[] = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      const cost = byteLength(line) + (kept.length > 0 ? 1 : 0);
      if (used + cost > options.maxBytes && kept.length > 0) break;
      if (used + cost > options.maxBytes && kept.length === 0) {
        // A single giant line: hard-truncate its tail bytes.
        const buf = Buffer.from(line, "utf-8");
        kept.unshift(buf.subarray(buf.length - options.maxBytes).toString("utf-8"));
        used = options.maxBytes;
        break;
      }
      kept.unshift(line);
      used += cost;
    }
    content = kept.join("\n");
    truncated = true;
    truncatedBy = "bytes";
  }

  return {
    content,
    truncated,
    truncatedBy,
    outputLines: content === "" ? 0 : content.split("\n").length,
    totalLines,
  };
}

/** Human-readable byte size, e.g. "4.0KB", "32.0KB", "1.2MB". */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + "MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + "KB";
  return bytes + "B";
}

/**
 * Cut at the last newline within maxBytes, else at the last complete UTF-8
 * character boundary. Never produces replacement characters from split
 * multibyte sequences.
 */
export function truncateAtBoundary(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const buf = Buffer.from(text, "utf-8");
  let slice = buf.subarray(0, maxBytes);

  // Prefer a trailing newline cut.
  const nl = slice.lastIndexOf(0x0a);
  if (nl > 0) return slice.subarray(0, nl).toString("utf-8");

  // Else back off to the last complete UTF-8 code point: a continuation byte
  // is 0b10xxxxxx (0x80-0xBF), so trim while the final byte is a continuation.
  while (slice.length > 0 && (slice[slice.length - 1] & 0xc0) === 0x80) {
    slice = slice.subarray(0, slice.length - 1);
  }
  if (slice.length > 0 && slice[slice.length - 1] >= 0x80) {
    // Trim a truncated lead byte too.
    slice = slice.subarray(0, slice.length - 1);
  }
  return slice.toString("utf-8");
}
