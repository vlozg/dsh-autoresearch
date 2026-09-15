/**
 * Pure derivations from the experiment snapshot: per-run delta vs the best
 * keep so far, live loop state, and the session subtitle line.
 */

import { formatAgo } from "../shared/format";
import type { ExperimentSnapshot, RunEntry } from "../shared/wire";

export interface RunDelta {
  label: string;
  good: boolean;
}

/** Delta vs the best kept result before this run: "+10.4% worse" / "-2.8% better". */
export function bestDelta(snapshot: ExperimentSnapshot, entry: RunEntry): RunDelta | null {
  const earlier = snapshot.runs.filter((other) => other.run < entry.run && other.segment === entry.segment && other.status === "keep");
  let best: number | null = null;
  for (const other of earlier) {
    if (other.metric <= 0 || !Number.isFinite(other.metric)) continue;
    if (best === null || (snapshot.bestDirection === "lower" ? other.metric < best : other.metric > best)) {
      best = other.metric;
    }
  }
  if (best === null || best === 0 || entry.metric <= 0 || !Number.isFinite(entry.metric)) return null;
  const delta = entry.metric - best;
  const pct = Math.abs((delta / best) * 100).toFixed(1);
  const worse = snapshot.bestDirection === "lower" ? delta > 0 : delta < 0;
  return { label: (delta > 0 ? "+" : "\u2212") + pct + "% " + (worse ? "worse" : "better"), good: !worse };
}

/** Live loop/run state for the capsule pill and header badges. */
export function loopState(snapshot: ExperimentSnapshot): { state: string; label: string } {
  if (snapshot.running !== null) return { state: "running", label: snapshot.running.phase === "checks" ? "checking" : "running" };
  if (snapshot.loop) return { state: "live", label: "loop on" };
  if (snapshot.loopStopReason !== null) return { state: "idle", label: "loop off" };
  return { state: "off", label: "idle" };
}

/** "workdir · metric · Segment n · updated Xm ago" line under the session title. */
export function sessionSubtitle(snapshot: ExperimentSnapshot, now: number): string {
  const workName = snapshot.workDir.split("/").filter(Boolean).pop() ?? snapshot.workDir;
  const parts = [workName, snapshot.metricLabel ?? snapshot.metricName, "Segment " + String(snapshot.currentSegment)];
  const lastRun = snapshot.runs.length > 0 ? snapshot.runs[snapshot.runs.length - 1].timestamp : null;
  if (lastRun !== null) parts.push("updated " + formatAgo(lastRun, now));
  if (snapshot.loopStopReason !== null) parts.push(snapshot.loopStopReason);
  return parts.join(" · ");
}
