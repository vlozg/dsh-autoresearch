/**
 * Client-side data layer for the autoresearch dashboard: one SSE stream
 * carrying state snapshots and running tails, plus the stop/resume actions.
 * Wire shapes come from src/shared/wire.ts — the typechecker-shared host↔client
 * contract (type-only imports, erased at build: the client bundle stays
 * platform-pure with zero runtime coupling to the host hexagon).
 */

import type {
  AutoResearchEvent,
  DetectedSession,
  DetectResult,
  ExperimentSnapshot,
  RunningExperiment,
} from "../shared/wire";

// Re-exported for the view layer and tests (the client's public type surface).
export type {
  AutoResearchEvent,
  DetectedSession,
  DetectResult,
  ExperimentSnapshot,
  MetricDef,
  RunEntry,
  RunningExperiment,
} from "../shared/wire";

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
  /** Last detect scan result; null until the first scan. */
  readonly detected: DetectResult | null;
  readonly detecting: boolean;
  readonly detectError: string | null;
}

const EVENTS_URL = "/autoresearch/events";
const DETECT_URL = "/autoresearch/detect";
const STOP_URL = "/autoresearch/stop";
const RESUME_URL = "/autoresearch/resume";

/** Defensive parse of the /detect payload (browser-side, host may be older). */
function parseDetectResult(value: unknown): DetectResult | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as { attached?: unknown; unattached?: unknown };
  const parseList = (input: unknown): DetectedSession[] => {
    if (!Array.isArray(input)) return [];
    const out: DetectedSession[] = [];
    for (const item of input) {
      if (item === null || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.workDir !== "string" || typeof entry.name !== "string") continue;
      out.push({
        sessionId: typeof entry.sessionId === "string" ? entry.sessionId : null,
        workDir: entry.workDir,
        name: entry.name,
        metricName: typeof entry.metricName === "string" ? entry.metricName : "metric",
        metricUnit: typeof entry.metricUnit === "string" ? entry.metricUnit : "",
        bestDirection: entry.bestDirection === "higher" ? "higher" : "lower",
        metricLabel: typeof entry.metricLabel === "string" ? entry.metricLabel : null,
        objectiveLabel: typeof entry.objectiveLabel === "string" ? entry.objectiveLabel : null,
        currentSegment: typeof entry.currentSegment === "number" ? entry.currentSegment : 0,
        runs: typeof entry.runs === "number" ? entry.runs : 0,
        bestMetric: typeof entry.bestMetric === "number" ? entry.bestMetric : null,
        lastTimestamp: typeof entry.lastTimestamp === "number" ? entry.lastTimestamp : null,
      });
    }
    return out;
  };
  return { attached: parseList(raw.attached), unattached: parseList(raw.unattached) };
}

export class AutoresearchClientStore {
  private readonly bySession = new Map<string, SessionView>();
  private listeners = new Set<() => void>();
  private events: EventSourceLike | undefined;
  private detected: DetectResult | null = null;
  private detecting = false;
  private detectError: string | null = null;
  private snapshot: AutoresearchView = {
    sessions: [],
    subscribed: false,
    detected: null,
    detecting: false,
    detectError: null,
  };
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
    this.snapshot = {
      sessions,
      subscribed: this.events !== undefined,
      detected: this.detected,
      detecting: this.detecting,
      detectError: this.detectError,
    };
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
        const value: unknown = JSON.parse(message.data);
        if (value === null || typeof value !== "object") return;
        // Narrow the kind discriminant before trusting the payload; unknown
        // kinds (newer host) are ignored, not rejected (version skew).
        if ((value as { kind?: unknown }).kind !== "state") return;
        const event = value as Extract<AutoResearchEvent, { kind: "state" }>;
        this.applyState(event.sessionId, event.snapshot);
      } catch {
        // Malformed frame: ignore, the stream self-heals on reconnect.
      }
      this.publish();
    };
    const runningHandler = (message: { data: string }): void => {
      if (!this.started || this.events !== events) return;
      try {
        const value: unknown = JSON.parse(message.data);
        if (value === null || typeof value !== "object") return;
        if ((value as { kind?: unknown }).kind !== "running") return;
        const event = value as Extract<AutoResearchEvent, { kind: "running" }>;
        this.applyRunning(event.sessionId, event.running, event.tail);
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
    this.detected = null;
    this.detecting = false;
    this.detectError = null;
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

  /**
   * Scan for past autoresearch sessions around the open conversations'
   * workdirs. Attached workdirs appear as cards through the SSE stream; the
   * raw result is kept in the view for the unattached listing.
   */
  async detectPastSessions(sessionId?: string): Promise<void> {
    if (this.detecting) return;
    this.detecting = true;
    this.detectError = null;
    this.publish();
    try {
      const suffix = sessionId !== undefined && sessionId !== ""
        ? "?sessionId=" + encodeURIComponent(sessionId)
        : "";
      const response = await this.deps.fetchFn(DETECT_URL + suffix);
      if (!response.ok) {
        // Prefer the host's JSON error body (e.g. 500 {error}) when present;
        // a bare 400/404 from an outdated host bundle has no body at all.
        let detail: string | null = null;
        try {
          const body = (await response.json()) as { error?: unknown };
          if (typeof body?.error === "string" && body.error !== "") detail = body.error;
        } catch {
          // No parseable body — fall through to the generic message.
        }
        this.detectError = detail
          ?? "detection failed — is the host bundle current? (restart DSH to pick up the detect route)";
      } else {
        const parsed = parseDetectResult(await response.json());
        if (parsed === null) this.detectError = "unexpected detection response";
        else this.detected = parsed;
      }
    } catch (error) {
      this.detectError = error instanceof Error ? error.message : String(error);
    } finally {
      this.detecting = false;
      this.publish();
    }
  }

  stopExperiment(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    return this.action(STOP_URL, sessionId);
  }

  resumeExperiment(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    return this.action(RESUME_URL, sessionId);
  }
}
