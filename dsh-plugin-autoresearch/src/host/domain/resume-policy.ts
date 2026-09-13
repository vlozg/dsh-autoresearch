/**
 * Auto-resume limits (pi parity): how many idle turns the loop may prompt
 * itself, and the consecutive-failure override that stops it early.
 */

import type { RunEntry } from "./model";
import { countConsecutiveDiscardOrCrashResults } from "./metrics";

export const AUTORESUME_TURN_LIMIT = 200;
export const CONSECUTIVE_FAILURE_OVERRIDE_LIMIT = 20;

/** Auto-resume stop decision, mirroring pi's autoResumeStopReasonFor. */
export function autoResumeStopReason(state: {
  autoResumeTurns: number;
  results: RunEntry[];
  currentSegment: number;
}): string | null {
  if (state.autoResumeTurns >= AUTORESUME_TURN_LIMIT) {
    return `Autoresearch auto-resume limit reached (${AUTORESUME_TURN_LIMIT} turns)`;
  }
  const failures = countConsecutiveDiscardOrCrashResults(state.results, state.currentSegment);
  if (failures > CONSECUTIVE_FAILURE_OVERRIDE_LIMIT) {
    return `Autoresearch auto-resume stopped — ${failures} consecutive discards/crashes`;
  }
  return null;
}