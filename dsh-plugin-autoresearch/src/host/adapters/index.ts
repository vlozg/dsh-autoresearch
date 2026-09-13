/**
 * Node adapter kit — the ready-made ServiceDeps for the host composition
 * root (and tests that want the real filesystem under the ports).
 */

import type { ServiceDeps } from "../app/ports";
import { findAutoWorkdirs, summarizeWorkdir } from "../detect";
import { childRunner } from "./child-runner";
import { fsLogStore } from "./fs-log-store";
import { nodeGit } from "./node-git";
import { shellHooks } from "./shell-hooks";
import { systemClock } from "./system-clock";

/** Real-process, real-filesystem implementation of every driven port. */
export function nodeServiceDeps(): ServiceDeps {
  return {
    clock: systemClock,
    logStore: fsLogStore,
    git: nodeGit,
    runner: childRunner,
    hooks: shellHooks,
    scanner: { findAutoWorkdirs, summarize: summarizeWorkdir },
  };
}