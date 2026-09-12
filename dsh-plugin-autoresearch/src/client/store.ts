/**
 * Client-side data layer for the autoresearch dashboard: one SSE stream
 * carrying state snapshots and running tails, plus the stop/resume actions.
 * Mirrors the host contract in src/host/experiment.ts (structural types only,
 * no host imports — the client bundle stays platform-pure).
 */

export interface RunEntry {
  run: number;
  commit: string;
  metric: number;
  metrics: Record<string, number>;
  status: "keep" | "discard" | "crash" | "checks_failed";
  description: string;
  timestamp: number;
  segment: number;
  confidence: number | null;
  asi?: Record<string, unknown>;
}

export interface MetricDef {
  name: string;
  unit: string;
}

export interface RunningExperiment {
  command: string;
  startedAt: number;
  phase: "running" | "checks";
}

export interface ExperimentSnapshot {
  sessionId: string;
  workDir: string;
  name: string;
  metricName: string;
  metricUnit: string;
  bestDirection: "lower" | "higher";
  currentSegment: number;
  maxExperiments: number | null;
  baseline: number | null;
  bestMetric: number | null;
  confidence: number | null;
  runs: RunEntry[];
  secondaryMetrics: MetricDef[];
  running: RunningExperiment | null;
  loop: boolean;
  loopStopReason: string | null;
  experimentsThisSession: number;
  autoResumeTurns: number;
}

export type AutoResearchEvent =
  | { kind: "state"; sessionId: string; snapshot: ExperimentSnapshot }
  | { kind: "running"; sessionId: string; running: RunningExperiment; tail?: string };

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data: string }) => void): void;
  removeEventListener?(type: string, listener: (event: { data: string }) => void): void;
  onerror: ((event: unknown) => void) | null;
  close(): void;
}

export interface AutoresearchClientDeps {
  fetchFn: (
    url: string,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  eventSourceFactory: (url: string) => EventSourceLike;
}

/** One session's live view: latest snapshot plus the newest running tail. */
export interface SessionView {
  snapshot: ExperimentSnapshot;
  tail: string | undefined;
}

export interface AutoresearchView {
  readonly sessions: readonly SessionView[];
  readonly subscribed: boolean;
}

const EVENTS_URL = "/autoresearch/events";
const STOP_URL = "/autoresearch/stop";
const RESUME_URL = "/autoresearch/resume";

export class AutoresearchClientStore {
  private readonly bySession = new Map<string, SessionView>();
  private listeners = new Set<() => void>();
  private events: EventSourceLike | undefined;
  private snapshot: AutoresearchView = { sessions: [], subscribed: false };
  private started = false;
  private holders = 0;

  constructor(private readonly deps: AutoresearchClientDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AutoresearchView => this.snapshot;

  private publish(): void {
    // Most recently active session first (running > looping > newest run).
    const sessions = [...this.bySession.values()].sort((a, b) => {
      const rank = (v: SessionView): number =>
        (v.snapshot.running !== null ? 2 : 0) + (v.snapshot.loop ? 1 : 0);
      if (rank(b) !== rank(a)) return rank(b) - rank(a);
      const lastA = a.snapshot.runs[a.snapshot.runs.length - 1]?.timestamp ?? 0;
      const lastB = b.snapshot.runs[b.snapshot.runs.length - 1]?.timestamp ?? 0;
      return lastB - lastA;
    });
    this.snapshot = { sessions, subscribed: this.events !== undefined };
    for (const listener of [...this.listeners]) listener();
  }

  private applyState(sessionId: string, snapshot: ExperimentSnapshot): void {
    const previous = this.bySession.get(sessionId);
    this.bySession.set(sessionId, { snapshot, tail: previous?.tail });
  }

  private applyRunning(sessionId: string, running: RunningExperiment, tail?: string): void {
    const previous = this.bySession.get(sessionId);
    if (previous === undefined) return;
    const snapshot: ExperimentSnapshot = { ...previous.snapshot, running };
    this.bySession.set(sessionId, {
      snapshot,
      tail: tail !== undefined && tail !== "" ? tail : previous.tail,
    });
  }

  private connectEvents(): void {
    const previous = this.events;
    this.events = undefined;
    previous?.close();
    const events = this.deps.eventSourceFactory(EVENTS_URL);
    this.events = events;
    const stateHandler = (message: { data: string }): void => {
      if (!this.started || this.events !== events) return;
      try {
        const event = JSON.parse(message.data) as AutoResearchEvent;
        if (event.kind === "state") this.applyState(event.sessionId, event.snapshot);
      } catch {
        // Malformed frame: ignore, the stream self-heals on reconnect.
      }
      this.publish();
    };
    const runningHandler = (message: { data: string }): void => {
      if (!this.started || this.events !== events) return;
      try {
        const event = JSON.parse(message.data) as AutoResearchEvent;
        if (event.kind === "running") this.applyRunning(event.sessionId, event.running, event.tail);
      } catch {
        // Ignore malformed frames.
      }
      this.publish();
    };
    events.addEventListener("state", stateHandler);
    events.addEventListener("running", runningHandler);
    events.onerror = () => {
      // EventSource reconnects on its own; reflect the gap in the badge.
      if (this.events === events) this.publish();
    };
  }

  /** Hold the stream for one consumer's lifetime (refcounted). */
  hold(): () => void {
    this.holders += 1;
    if (!this.started) {
      this.started = true;
      this.connectEvents();
      this.publish();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders -= 1;
      if (this.holders <= 0) this.releaseAll();
    };
  }

  releaseAll(): void {
    this.started = false;
    this.holders = 0;
    const previous = this.events;
    this.events = undefined;
    previous?.close();
    this.bySession.clear();
    this.publish();
  }

  private async action(url: string, sessionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const response = await this.deps.fetchFn(url, {
        method: "POST",
        body: JSON.stringify({ sessionId }),
        headers: { "content-type": "application/json" },
      });
      if (response.ok) return { ok: true };
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      return { ok: false, error: body !== null && typeof body.error === "string" ? body.error : "request failed" };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  stopExperiment(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    return this.action(STOP_URL, sessionId);
  }

  resumeExperiment(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    return this.action(RESUME_URL, sessionId);
  }
}
