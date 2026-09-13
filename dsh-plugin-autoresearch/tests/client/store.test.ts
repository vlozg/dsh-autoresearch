import { describe, expect, it } from "vitest";
import {
  AutoresearchClientStore,
  type AutoResearchEvent,
  type EventSourceLike,
  type ExperimentSnapshot,
} from "../../src/client/features/dashboard/store";

interface FakeSource {
  listeners: Map<string, (event: { data: string }) => void>;
  onerror: ((event: unknown) => void) | null;
  closed: boolean;
}

function snapshotOf(overrides: Partial<ExperimentSnapshot> = {}): ExperimentSnapshot {
  return {
    sessionId: "s1",
    workDir: "/tmp/demo",
    name: "demo",
    metricName: "total_us",
    metricUnit: "us",
    bestDirection: "lower",
    metricLabel: null,
    objectiveLabel: null,
    currentSegment: 1,
    maxExperiments: null,
    baseline: 100,
    bestMetric: 80,
    confidence: 2.5,
    runs: [
      {
        run: 1,
        commit: "abcd1234",
        metric: 80,
        metrics: {},
        status: "keep",
        description: "seed",
        timestamp: 10,
        segment: 1,
        confidence: null,
      },
    ],
    secondaryMetrics: [],
    running: null,
    loop: true,
    loopStopReason: null,
    experimentsThisSession: 1,
    autoResumeTurns: 3,
    ...overrides,
  };
}

function harness(): {
  store: AutoresearchClientStore;
  source: FakeSource;
  emit: (event: AutoResearchEvent) => void;
} {
  const source: FakeSource = { listeners: new Map(), onerror: null, closed: false };
  const like: EventSourceLike = {
    addEventListener(type, listener) {
      source.listeners.set(type, listener);
    },
    set onerror(handler: ((event: unknown) => void) | null) {
      source.onerror = handler;
    },
    get onerror() {
      return source.onerror;
    },
    close() {
      source.closed = true;
    },
  };
  const store = new AutoresearchClientStore({
    fetchFn: async () => ({ ok: true, json: async () => ({}) }),
    eventSourceFactory: () => like,
  });
  const emit = (event: AutoResearchEvent): void => {
    const handler = source.listeners.get(event.kind);
    if (handler !== undefined) handler({ data: JSON.stringify(event) });
  };
  return { store, source, emit };
}

describe("AutoresearchClientStore", () => {
  it("starts the stream on first hold and stops on last release", () => {
    const { store, source } = harness();
    const release = store.hold();
    expect(store.getSnapshot().subscribed).toBe(true);
    expect(source.closed).toBe(false);
    release();
    expect(store.getSnapshot()).toEqual({ sessions: [], subscribed: false, detected: null, detecting: false, detectError: null });
    expect(source.closed).toBe(true);
  });

  it("refcounts multiple holders", () => {
    const { store, source } = harness();
    const releaseA = store.hold();
    const releaseB = store.hold();
    releaseA();
    expect(store.getSnapshot().subscribed).toBe(true);
    expect(source.closed).toBe(false);
    releaseB();
    expect(source.closed).toBe(true);
  });

  it("applies state snapshots and running tails", () => {
    const { store, emit } = harness();
    const release = store.hold();
    emit({ kind: "state", sessionId: "s1", snapshot: snapshotOf() });
    emit({
      kind: "running",
      sessionId: "s1",
      running: { command: "bash .auto/measure.sh", startedAt: 99, phase: "running" },
      tail: "METRIC total_us=78\n",
    });
    const view = store.getSnapshot();
    expect(view.sessions).toHaveLength(1);
    const session = view.sessions[0];
    expect(session.snapshot.name).toBe("demo");
    expect(session.snapshot.running?.command).toBe("bash .auto/measure.sh");
    expect(session.tail).toBe("METRIC total_us=78\n");
    release();
  });

  it("keeps the last tail when a running event omits one", () => {
    const { store, emit } = harness();
    const release = store.hold();
    emit({ kind: "state", sessionId: "s1", snapshot: snapshotOf() });
    emit({ kind: "running", sessionId: "s1", running: { command: "c", startedAt: 1, phase: "running" }, tail: "one" });
    emit({ kind: "running", sessionId: "s1", running: { command: "c", startedAt: 1, phase: "checks" } });
    expect(store.getSnapshot().sessions[0].tail).toBe("one");
    expect(store.getSnapshot().sessions[0].snapshot.running?.phase).toBe("checks");
    release();
  });

  it("sorts running sessions before looping ones", () => {
    const { store, emit } = harness();
    const release = store.hold();
    emit({ kind: "state", sessionId: "looping", snapshot: snapshotOf({ sessionId: "looping", loop: true, running: null }) });
    emit({
      kind: "state",
      sessionId: "active",
      snapshot: snapshotOf({ sessionId: "active", loop: false, running: { command: "c", startedAt: 1, phase: "running" } }),
    });
    expect(store.getSnapshot().sessions[0].snapshot.sessionId).toBe("active");
    release();
  });

  it("posts stop and resume as JSON with the session id", async () => {
    const calls: { url: string; init?: { method?: string; body?: string } }[] = [];
    const source: FakeSource = { listeners: new Map(), onerror: null, closed: false };
    const like: EventSourceLike = {
      addEventListener() {},
      onerror: null,
      close() {
        source.closed = true;
      },
    };
    const store = new AutoresearchClientStore({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ ok: true }) };
      },
      eventSourceFactory: () => like,
    });
    const release = store.hold();
    await store.stopExperiment("s1");
    await store.resumeExperiment("s1");
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("/autoresearch/stop");
    expect(calls[0].init?.body).toBe('{"sessionId":"s1"}');
    expect(calls[1].url).toBe("/autoresearch/resume");
    release();
  });

  it("detectPastSessions stores the parsed scan result", async () => {
    const source: FakeSource = { listeners: new Map(), onerror: null, closed: false };
    const like: EventSourceLike = {
      addEventListener(type, listener) { source.listeners.set(type, listener); },
      set onerror(handler) { source.onerror = handler; },
      get onerror() { return source.onerror; },
      close() { source.closed = true; },
    };
    const calls: string[] = [];
    const store = new AutoresearchClientStore({
      fetchFn: async (url) => {
        calls.push(url);
        return {
          ok: true,
          json: async () => ({
            attached: [{ sessionId: "s1", workDir: "/live", name: "Live", metricName: "total_ms", metricUnit: "ms", bestDirection: "lower", currentSegment: 0, runs: 1, bestMetric: 5, lastTimestamp: 20 }],
            unattached: [{ sessionId: null, workDir: "/past", name: "Past", metricName: "total_ms", metricUnit: "ms", bestDirection: "lower", currentSegment: 0, runs: 3, bestMetric: 2, lastTimestamp: 10 }],
          }),
        };
      },
      eventSourceFactory: () => like,
    });
    const release = store.hold();
    await store.detectPastSessions("s1");
    expect(calls).toEqual(["/autoresearch/detect?sessionId=s1"]);
    const view = store.getSnapshot();
    expect(view.detecting).toBe(false);
    expect(view.detectError).toBeNull();
    expect(view.detected?.attached).toHaveLength(1);
    expect(view.detected?.unattached[0].name).toBe("Past");
    release();
    expect(store.getSnapshot().detected).toBeNull();
  });

  it("detectPastSessions records failures without throwing", async () => {
    const source: FakeSource = { listeners: new Map(), onerror: null, closed: false };
    const like: EventSourceLike = {
      addEventListener(type, listener) { source.listeners.set(type, listener); },
      set onerror(handler) { source.onerror = handler; },
      get onerror() { return source.onerror; },
      close() { source.closed = true; },
    };
    const store = new AutoresearchClientStore({
      fetchFn: async () => ({ ok: false, json: async () => { throw new Error("bare 400 — no body"); } }),
      eventSourceFactory: () => like,
    });
    const release = store.hold();
    await expect(store.detectPastSessions()).resolves.toBeUndefined();
    const view = store.getSnapshot();
    expect(view.detecting).toBe(false);
    expect(view.detectError).toBe("detection failed — is the host bundle current? (restart DSH to pick up the detect route)");
    release();
  });

  it("detectPastSessions surfaces the host JSON error body when present", async () => {
    const source: FakeSource = { listeners: new Map(), onerror: null, closed: false };
    const like: EventSourceLike = {
      addEventListener(type, listener) { source.listeners.set(type, listener); },
      set onerror(handler) { source.onerror = handler; },
      get onerror() { return source.onerror; },
      close() { source.closed = true; },
    };
    const store = new AutoresearchClientStore({
      fetchFn: async () => ({ ok: false, status: 500, json: async () => ({ error: "cannot get property \"agents\" without inject" }) }),
      eventSourceFactory: () => like,
    });
    const release = store.hold();
    await store.detectPastSessions();
    expect(store.getSnapshot().detectError).toBe('cannot get property "agents" without inject');
    release();
  });
});
