/**
 * Pure parsers that turn the tools' rendered text (the only artifact the
 * frozen conversation slice carries) into structured card models.
 */

export interface ParsedMetrics {
  name: string;
  value: number;
}

export interface RunTextModel {
  kind: "passed" | "failed" | "timeout" | "aborted" | "checks_timeout" | "checks_failed" | "unknown";
  headline: string;
  durationSeconds: number | null;
  exitCode: number | null;
  parsed: ParsedMetrics[];
  primaryName: string | null;
  bestLine: string | null;
  tail: string;
  truncated: boolean;
}

export interface LogTextModel {
  status: "keep" | "discard" | "crash" | "checks_failed" | "unknown";
  run: number | null;
  description: string;
  baselineLine: string | null;
  deltaLine: string | null;
  secondaryLine: string | null;
  confidenceLine: string | null;
  confidence: number | null;
  gitLine: string | null;
  segmentLine: string | null;
  limitReached: boolean;
}

export interface InitTextModel {
  ok: boolean;
  name: string | null;
  error: string | null;
}

/** "75.3us" → 75.3, "2kb" → 2, "-12%" → -12. Units are suffixes. */
function numericPrefix(raw: string): number {
  const match = raw.match(/^(-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/);
  return match !== null ? Number(match[1]) : Number.NaN;
}

/** Parse the run_experiment result text (host format, see experiment.ts). */
export function parseRunText(text: string): RunTextModel {
  const lines = text.split("\n");
  const model: RunTextModel = {
    kind: "unknown",
    headline: "",
    durationSeconds: null,
    exitCode: null,
    parsed: [],
    primaryName: null,
    bestLine: null,
    tail: "",
    truncated: false,
  };
  const statusIndex = lines.findIndex((line) =>
    /^(🛑|⏰|💥|✅ Benchmark|✅ PASSED)/.test(line),
  );
  if (statusIndex >= 0) {
    const headline = lines[statusIndex];
    model.headline = headline;
    const durationMatch = headline.match(/(?:in|after) ([0-9.]+)s/);
    if (durationMatch !== null) model.durationSeconds = Number(durationMatch[1]);
    const exitMatch = headline.match(/exit code (-?[0-9]+)/);
    if (exitMatch !== null) model.exitCode = Number(exitMatch[1]);
    if (headline.startsWith("🛑")) model.kind = "aborted";
    else if (headline.startsWith("⏰ CHECKS")) model.kind = "checks_timeout";
    else if (headline.startsWith("⏰")) model.kind = "timeout";
    else if (headline.startsWith("💥 CHECKS")) model.kind = "checks_failed";
    else if (headline.startsWith("💥")) model.kind = "failed";
    else model.kind = "passed";
    // "✅ Benchmark PASSED" + a following CHECKS line means the checks phase
    // decided the outcome; the checks verdict wins over the benchmark pass.
    if (model.kind === "passed") {
      for (const line of lines.slice(statusIndex + 1, statusIndex + 4)) {
        if (line.startsWith("💥 CHECKS")) {
          model.kind = "checks_failed";
          break;
        }
        if (line.startsWith("⏰ CHECKS")) {
          model.kind = "checks_timeout";
          break;
        }
      }
    }
    // The tail is everything after the first blank line from the status block on.
    const tailStart = lines.findIndex((line, index) => index > statusIndex && line.trim() === "");
    if (tailStart >= 0) {
      let tailLines = lines.slice(tailStart + 1);
      // Drop a leading "📐 Parsed metrics:" / "Use these values..." pair if the
      // blank line matched before them.
      while (tailLines.length > 0 && /^📐|^Use these values|^📊 Current best/.test(tailLines[0])) {
        tailLines = tailLines.slice(1);
      }
      while (tailLines.length > 0 && tailLines[0].trim() === "") tailLines = tailLines.slice(1);
      model.tail = tailLines.join("\n");
    }
  }
  for (const line of lines) {
    const bestMatch = line.match(/^📊 Current best (.+?): (.+)$/);
    if (bestMatch !== null) model.bestLine = line;
    const parsedMatch = line.match(/^📐 Parsed metrics:(.*)$/);
    if (parsedMatch !== null) {
      const star = parsedMatch[1].match(/★ ([^= ]+)=([^ ]+)/);
      if (star !== null) {
        model.primaryName = star[1];
        model.parsed.push({ name: star[1], value: numericPrefix(star[2]) });
      }
      const rest = parsedMatch[1].replace(/★ [^= ]+=[^ ]+/, "");
      for (const pair of rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=([^ ]+)/g)) {
        model.parsed.push({ name: pair[1], value: numericPrefix(pair[2]) });
      }
    }
    if (/\[Showing last /.test(line)) model.truncated = true;
  }
  if (model.tail === "" && statusIndex >= 0) model.tail = lines.slice(statusIndex + 1).join("\n").trim();
  return model;
}

/** Parse the log_experiment result text. */
export function parseLogText(text: string): LogTextModel {
  const model: LogTextModel = {
    status: "unknown",
    run: null,
    description: "",
    baselineLine: null,
    deltaLine: null,
    secondaryLine: null,
    confidenceLine: null,
    confidence: null,
    gitLine: null,
    segmentLine: null,
    limitReached: text.includes("🛑 Maximum experiments reached"),
  };
  const head = text.match(/^Logged #([0-9]+): (keep|discard|crash|checks_failed) — (.*)$/m);
  if (head !== null) {
    model.run = Number(head[1]);
    model.status = head[2] as LogTextModel["status"];
    model.description = head[3];
  }
  for (const line of text.split("\n")) {
    if (line.startsWith("Baseline ")) {
      model.baselineLine = line;
      const deltaMatch = line.match(/\| this: (.*)$/);
      if (deltaMatch !== null) model.deltaLine = deltaMatch[1];
    } else if (line.startsWith("Secondary: ")) {
      model.secondaryLine = line;
    } else if (/^(📊|⚠️) Confidence:/.test(line)) {
      model.confidenceLine = line;
      const confMatch = line.match(/Confidence: ([0-9.]+)×/);
      if (confMatch !== null) model.confidence = Number(confMatch[1]);
    } else if (line.startsWith("📝 Git:") || line.startsWith("⚠️ Git")) {
      model.gitLine = line;
    } else if (/^\([0-9]+ experiments/.test(line)) {
      model.segmentLine = line;
    }
  }
  return model;
}

/** Parse the init_experiment result text. */
export function parseInitText(text: string): InitTextModel {
  const ok = text.startsWith("✅");
  if (!ok) return { ok: false, name: null, error: text };
  const name = text.match(/initialized: "(.*)"$/);
  return { ok: true, name: name !== null ? name[1] : null, error: null };
}
