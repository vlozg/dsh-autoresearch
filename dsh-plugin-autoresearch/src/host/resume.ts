/**
 * Auto-resume injector — pi-style idle continuation (NOT goal-based; the loop
 * must never be self-terminable by the model). Mirrors the dsh goal-round
 * driver's fences, simplified for our single-round semantics:
 *
 * - on `agent/status` idle → after a short settled window, queue the resume
 *   user message via `agent.followup` inside `ctx.agents.withoutInitiator`;
 * - `agent/inbox/inserted` for a nextTurn message cancels a pending resume
 *   (competing prompt fence);
 * - turn/end `aborted` cancels pending AND disables the loop (never
 *   auto-restart after cancellation);
 * - guards from pi: turn limit (200) and consecutive discard/crash limit (20);
 *   the chat-only-turn guard (experiments must have run this session).
 */

import { FiberState } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { ExperimentService } from "./experiment";
import { formatElapsed } from "./domain/metrics";
import type { SessionRuntime } from "./experiment";
import { autoResumeStopReason } from "./domain/resume-policy";

/** Outlasts the agent loop's internal retry timing (pi parity). */
const SETTLED_WINDOW_MS = 800;

const BENCHMARK_GUARDRAIL =
  "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks.";

function composeResumeMessage(runtime: SessionRuntime): string {
  return [
    "Run the next iteration now.",
    "Use the persisted autoresearch state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment (pass title max 70 chars, summary max 180 chars, and description with the full evidence).",
    BENCHMARK_GUARDRAIL,
  ].join(" ")
    // Session-scoped context the model may not retain after compaction:
    + ` [metric: ${runtime.state.metricName}${runtime.state.metricUnit ? ` (${runtime.state.metricUnit})` : ""}, segment ${runtime.state.currentSegment}]`;
}

interface InjectorState {
  pendingTimer: ReturnType<typeof setTimeout> | null;
}

export class AutoResumeInjector {
  private states = new Map<Agent, InjectorState>();

  constructor(
    private readonly ctx: Context,
    private readonly service: ExperimentService,
  ) {}

  arm(): () => void {
    const disposers = [
      this.ctx.on("agent/status", ({ agent, status }) => {
        if (status === "idle") this.onIdle(agent);
        else this.cancelPending(agent);
      }),
      this.ctx.on("agent/inbox/inserted", ({ agent, message }) => {
        // A real prompt arriving nextTurn beats the auto-resume.
        if (agent.inbox.nextTurn.some((candidate) => candidate.id === message.id)) {
          this.cancelPending(agent);
        }
      }),
      this.ctx.on("agent/error", ({ agent }) => {
        this.cancelPending(agent);
      }),
      this.ctx.on("agent/disposed", ({ agent }) => {
        this.cancelPending(agent);
        this.states.delete(agent);
      }),
      // Session-event fence (driver parity): user cancellation stops the
      // loop entirely; a max-tokens turn fails closed too (no auto-retry on
      // an overflowed context) — the dashboard can re-arm.
      this.ctx.on("session/event", (session, event) => {
        const agent = this.ctx.agents.get(session.id);
        if (agent === undefined || agent.session !== session) return;
        if (event.type !== "turn/end") return;
        const reason = event.data.reason;
        if (reason.kind !== "aborted" && reason.kind !== "max-tokens") return;
        const runtime = this.service.loopRuntime(agent.id);
        this.cancelPending(agent);
        if (runtime !== undefined && runtime.loop) {
          this.service.setLoop(
            agent.id,
            false,
            reason.kind === "aborted" ? "cancelled by user" : "turn ended with max-tokens",
          );
        }
      }),
    ];

    return () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // Teardown races are fine.
        }
      }
      for (const [, state] of this.states) this.clearTimer(state);
    };
  }

  private stateFor(agent: Agent): InjectorState {
    let state = this.states.get(agent);
    if (state === undefined) {
      state = { pendingTimer: null };
      this.states.set(agent, state);
    }
    return state;
  }

  private clearTimer(state: InjectorState): void {
    if (state.pendingTimer !== null) {
      clearTimeout(state.pendingTimer);
      state.pendingTimer = null;
    }
  }

  private cancelPending(agent: Agent): void {
    const state = this.states.get(agent);
    if (state !== undefined) this.clearTimer(state);
  }

  private onIdle(agent: Agent): void {
    const runtime = this.service.loopRuntime(agent.id);
    if (runtime === undefined || !runtime.loop) return;
    // Chat-only-turn guard (pi): a conversation turn with zero experiments
    // would otherwise loop forever.
    if (runtime.experimentsThisSession <= 0) return;

    const state = this.stateFor(agent);
    this.clearTimer(state);
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = null;
      void this.fire(agent, runtime);
    }, SETTLED_WINDOW_MS);
  }

  private async fire(agent: Agent, runtime: SessionRuntime): Promise<void> {
    const state = this.stateFor(agent);
    try {
      // All preconditions re-checked at fire time (debounce may be stale).
      if (this.ctx.fiber.state !== FiberState.ACTIVE) return;
      if (this.ctx.agents.get(agent.id) !== agent) return;
      if (agent.status !== "idle") return;
      if (!runtime.loop) return;
      if (runtime.running !== null) {
        // An experiment is in flight — reschedule for the next idle edge.
        this.onIdle(agent);
        return;
      }

      const stopReason = autoResumeStopReason({
        autoResumeTurns: runtime.autoResumeTurns,
        results: runtime.state.results,
        currentSegment: runtime.state.currentSegment,
      });
      if (stopReason !== null) {
        this.service.setLoop(runtime.sessionId, false, stopReason);
        return;
      }

      runtime.autoResumeTurns++;
      const message = createUserMessage({
        content: [{ type: "text", text: composeResumeMessage(runtime) }],
        source: {
          kind: "plugin",
          plugin: "autoresearch",
          form: "notice",
          summary: boundContextSummary(
            `autoresearch auto-resume — run the next iteration (turn ${runtime.autoResumeTurns})`,
          ),
        },
      });
      // Plugin-injected continuation carries no human authority.
      await this.ctx.agents.withoutInitiator(async () => {
        agent.followup(message);
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.ctx.logger.warn(`autoresearch: could not resume agent "${agent.id}": ${detail}`);
    } finally {
      state.pendingTimer = null;
    }
  }

  /** Exposed for tests + the dashboard's elapsed display. */
  static settledWindowMs(): number {
    return SETTLED_WINDOW_MS;
  }
}

void formatElapsed;
