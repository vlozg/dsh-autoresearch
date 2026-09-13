/**
 * shell.overlay occupant: the floating capsule and the expanding dashboard
 * panel — hero stats, running tail, run history, and stop/resume controls.
 */

import { Fragment, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { formatAgo, formatNum } from "../../shared/format";
import type { AutoresearchClientStore, AutoresearchView, ExperimentSnapshot, SessionView } from "./store";
import { loopState, sessionSubtitle } from "../../entities/derive";
import { RunRow, RunningCard } from "./runrow";
import { IconPause, IconPlay, IconStop, StatusDot } from "../../shared/bits";

/** Right-aligned loop/run badges for the carrier header row. */
export function SessionBadges(props: { snapshot: ExperimentSnapshot }): ReactNode {
  const snapshot = props.snapshot;
  const state = loopState(snapshot);
  const pillLabel = state.state === "running" ? "Running" : state.state === "live" ? "Loop active" : state.state === "idle" ? "Loop paused" : "Idle";
  return (
    <div className="ar-badges">
      <span className={"ar-pill ar-pill-" + state.state}>
        <span className="ar-pilldot" aria-hidden="true" />
        {pillLabel}
      </span>
      <span className="ar-pill">
        {String(snapshot.runs.length)}
        {snapshot.maxExperiments !== null ? "/" + String(snapshot.maxExperiments) : ""} runs
      </span>
    </div>
  );
}

/** "Detect past autoresearch sessions" button + discovered-session listing. */
export function DetectPanel(props: { store: AutoresearchClientStore; view: AutoresearchView; sessionId?: string }): ReactNode {
  const { store, view } = props;
  const detected = view.detected;
  const unattached = detected?.unattached ?? [];
  const attachedCount = detected?.attached.length ?? 0;
  return (
    <div className="ar-detect">
      <button type="button" className="ar-btn" disabled={view.detecting} onClick={() => void store.detectPastSessions(props.sessionId)}>
        {view.detecting ? "Scanning workspaces…" : "Detect past autoresearch sessions"}
      </button>
      {view.detectError !== null ? <div className="ar-note">⚠ {view.detectError}</div> : null}
      {detected !== null && attachedCount > 0 ? (
        <div className="ar-note">
          Loaded {attachedCount === 1 ? "1 past session" : String(attachedCount) + " past sessions"} into the dashboard.
        </div>
      ) : null}
      {detected !== null && unattached.length > 0 ? (
        <div className="ar-detlist">
          {unattached.map((item) => (
            <div key={item.workDir} className="ar-detrow">
              <span className="ar-detname">{item.name}</span>
              <span className="ar-detmeta">
                {item.runs} runs · {item.metricName}
                {item.lastTimestamp !== null ? " · " + formatAgo(item.lastTimestamp, Date.now()) : ""}
              </span>
              <span className="ar-detpath">{item.workDir}</span>
              <span className="ar-dethint">Open a conversation in this directory to continue it.</span>
            </div>
          ))}
        </div>
      ) : null}
      {detected !== null && attachedCount === 0 && unattached.length === 0 && view.detectError === null ? (
        <div className="ar-note">No past .auto/ sessions found near the open conversations.</div>
      ) : null}
    </div>
  );
}

const subscribeNever = (): (() => void) => () => {};
const snapshotNever = (): boolean => false;

/** External-store read of the better-sidebar carrier flag (set by index.ts). */
export interface FlagStore {
  getSnapshot(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface DashboardEntryProps {
  store: AutoresearchClientStore;
  /** When true, the sidebar tab carries the dashboard and the capsule hides. */
  sidebarMode?: FlagStore;
}

/** shell.overlay occupant: floating capsule + expanding dashboard panel. */
export function DashboardEntry(props: DashboardEntryProps): ReactNode {
  const { store } = props;
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const sidebarMode = useSyncExternalStore(
    props.sidebarMode !== undefined ? props.sidebarMode.subscribe : subscribeNever,
    props.sidebarMode !== undefined ? props.sidebarMode.getSnapshot : snapshotNever,
  );
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const holdRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const release = store.hold();
    holdRef.current = release;
    return () => {
      holdRef.current = null;
      release();
    };
  }, [store]);

  const hasRunning = view.sessions.some((session) => session.snapshot.running !== null);
  useEffect(() => {
    if (!hasRunning && !expanded) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunning, expanded]);

  // The better-sidebar tab is the carrier; the floating capsule yields.
  // (Placed after every hook so flipping the mode keeps hook order stable.)
  if (sidebarMode) return null;

  const session = view.sessions[0];
  const headline = session !== undefined ? loopState(session.snapshot) : { state: "off", label: "no session" };

  if (!expanded) {
    const best = session !== undefined && session.snapshot.bestMetric !== null
      ? formatNum(session.snapshot.bestMetric, session.snapshot.metricUnit)
      : null;
    return (
      <div
        className="ar-root"
        role="button"
        tabIndex={0}
        onClick={() => setExpanded(true)}
        onKeyDown={(event) => { if (event.key === "Enter") setExpanded(true); }}
      >
        <div className="ar-float" data-state={headline.state}>
          <StatusDot state={headline.state} />
          <span className="ar-float-loop">{headline.label}</span>
          {best !== null ? (
            <span className="ar-float-label">
              <span className="ar-float-metric">{best}</span>
              {session !== undefined ? (
                <span className="ar-float-count">
                  #{session.snapshot.runs.length > 0 ? String(session.snapshot.runs[session.snapshot.runs.length - 1].run) : "–"}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="ar-float-label">
              <span className="ar-float-metric">autoresearch</span>
              {session !== undefined ? <span className="ar-float-count">{session.snapshot.runs.length} runs</span> : null}
            </span>
          )}
        </div>
      </div>
    );
  }

  const runAction = async (kind: "stop" | "resume", sessionId: string): Promise<void> => {
    setBusy(kind);
    setActionError(null);
    const result = kind === "stop" ? await store.stopExperiment(sessionId) : await store.resumeExperiment(sessionId);
    setBusy(null);
    if (!result.ok) setActionError(result.error ?? "action failed");
  };

  return (
    <div className="ar-root">
      <div className="ar-panel" role="dialog" aria-label="autoresearch dashboard">
        <div className="ar-head">
          <div className="ar-head-main">
            <div className="ar-title">{session !== undefined ? session.snapshot.name : "Autoresearch"}</div>
            {session !== undefined ? (
              <div className="ar-subtitle">{view.subscribed ? sessionSubtitle(session.snapshot, now) : "reconnecting…"}</div>
            ) : null}
          </div>
          {session !== undefined ? <SessionBadges snapshot={session.snapshot} /> : null}
          <button type="button" className="ar-close" aria-label="Collapse dashboard" onClick={() => setExpanded(false)}>
            ×
          </button>
        </div>
        <div className="ar-body">
          {view.subscribed ? null : <div className="ar-connwarn">Feed disconnected — retrying…</div>}
          {session === undefined ? (
            <>
              <div className="ar-empty">
                {view.subscribed ? "No experiment sessions yet. Ask the agent to run init_experiment." : "Connecting to the experiment feed…"}
              </div>
              <DetectPanel store={store} view={view} />
            </>
          ) : (
            <SessionPanel session={session} now={now} />
          )}
          {actionError !== null ? <div className="ar-note">⚠ {actionError}</div> : null}
        </div>
        {session !== undefined ? (
          <div className="ar-actions">
            {session.snapshot.loop && session.snapshot.running === null ? (
              <button type="button" className="ar-btn" disabled={busy !== null} title="Stop the loop — resume any time with Resume loop" onClick={() => void runAction("stop", session.snapshot.sessionId)}>
                <IconPause /> {busy === "stop" ? "Pausing…" : "Pause"}
              </button>
            ) : null}
            {session.snapshot.running !== null ? (
              <button type="button" className="ar-btn ar-danger" disabled={busy !== null} onClick={() => void runAction("stop", session.snapshot.sessionId)}>
                <IconStop /> {busy === "stop" ? "Stopping…" : "Stop run"}
              </button>
            ) : !session.snapshot.loop ? (
              <button type="button" className="ar-btn ar-good" disabled={busy !== null} onClick={() => void runAction("resume", session.snapshot.sessionId)}>
                <IconPlay /> {busy === "resume" ? "Resuming…" : "Resume loop"}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const RUN_FILTERS = [
  { id: "all", label: "All" },
  { id: "keep", label: "Kept" },
  { id: "discard", label: "Discarded" },
  { id: "errors", label: "Errors" },
] as const;
type RunFilter = (typeof RUN_FILTERS)[number]["id"];

export function SessionPanel(props: { session: SessionView; tail?: string; now: number }): ReactNode {
  const { session, now } = props;
  const snapshot = session.snapshot;
  const [filter, setFilter] = useState<RunFilter>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [confInfo, setConfInfo] = useState(false);
  const dir = snapshot.bestDirection;
  const runs = [...snapshot.runs].reverse();
  const kept = snapshot.runs.filter((entry) => entry.status === "keep");
  const filtered = runs.filter((entry) => {
    if (filter === "keep" && entry.status !== "keep") return false;
    if (filter === "discard" && entry.status !== "discard") return false;
    if (filter === "errors" && entry.status !== "crash" && entry.status !== "checks_failed") return false;
    const needle = search.trim().toLowerCase();
    const hay = (entry.title ?? "") + " " + (entry.summary ?? "") + " " + entry.description;
    if (needle !== "" && !hay.toLowerCase().includes(needle)) return false;
    return true;
  });

  let bestGap: ReactNode = null;
  if (snapshot.bestMetric !== null && snapshot.baseline !== null && snapshot.baseline !== 0) {
    const pct = ((snapshot.bestMetric - snapshot.baseline) / snapshot.baseline) * 100;
    const improved = dir === "lower" ? pct < 0 : pct > 0;
    if (improved && Math.abs(pct) >= 0.05) {
      bestGap = (
        <div className="ar-hero-sub ar-good-stat">
          {Math.abs(pct).toFixed(1)}% {dir === "lower" ? "below" : "above"} baseline
        </div>
      );
    }
  }

  return (
    <>
      <div className="ar-hero">
        <div className="ar-hero-top">
          <span className="ar-hero-name">{snapshot.metricLabel ?? snapshot.metricName}</span>
          <span className="ar-hero-dir">{snapshot.objectiveLabel ?? (dir === "lower" ? "Lower is better ↓" : "Higher is better ↑")}</span>
        </div>
        <div className="ar-hero-grid">
          <div className="ar-hero-cell ar-hero-main">
            <div className="ar-hero-bestrow">
              <div className={"ar-hero-v" + (snapshot.bestMetric !== null ? " ar-good" : "")}>
                {snapshot.bestMetric !== null ? formatNum(snapshot.bestMetric, snapshot.metricUnit) : "–"}
              </div>
              {snapshot.bestMetric !== null ? <span className="ar-hero-bestpill">Best</span> : null}
            </div>
            {bestGap}
          </div>
          <div className="ar-hero-cell">
            <div className="ar-hero-k" title="First run in the current segment">Baseline</div>
            <div className="ar-hero-v">{snapshot.baseline !== null ? formatNum(snapshot.baseline, snapshot.metricUnit) : "–"}</div>
          </div>
          {snapshot.confidence !== null ? (
            <div className="ar-hero-cell">
              <button type="button" className="ar-hero-k ar-hero-kbtn" aria-expanded={confInfo} onClick={() => setConfInfo((prev) => !prev)}>
                Confidence ⓘ
              </button>
              <div className={"ar-hero-v" + (snapshot.confidence >= 2 ? " ar-good" : snapshot.confidence < 1 ? " ar-warn" : "")}>
                {snapshot.confidence.toFixed(1) + "×"}
              </div>
            </div>
          ) : null}
        </div>
        {confInfo ? (
          <div className="ar-hero-note">
            Best kept improvement over the segment baseline, measured in multiples of this segment's typical
            run-to-run spread (MAD). ≥2× means the gain is at least twice the noise floor.
          </div>
        ) : null}
      </div>
      <RunningCard snapshot={snapshot} tail={session.tail} now={now} />
      <div className="ar-expbar">
        <div className="ar-exp-h">
          Experiments <span className="ar-exp-count">{String(snapshot.runs.length)} runs</span>
        </div>
        <div className="ar-seg" role="group" aria-label="Filter runs">
          {RUN_FILTERS.map((f) => (
            <button key={f.id} type="button" className={"ar-segbtn" + (filter === f.id ? " ar-on" : "")} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={"ar-searchbtn" + (searchOpen ? " ar-on" : "")}
          aria-label="Search run descriptions"
          onClick={() => { setSearchOpen((prev) => !prev); if (searchOpen) setSearch(""); }}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <line x1="10.6" y1="10.6" x2="14" y2="14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {searchOpen ? (
        <input
          className="ar-search"
          type="search"
          placeholder="Filter runs…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      ) : null}
      <div className="ar-note">Δ vs best · {dir === "lower" ? "positive is worse" : "positive is better"}</div>
      {filtered.length === 0 ? (
        <div className="ar-empty">
          {snapshot.runs.length === 0 ? "No logged experiments yet in this segment." : "No runs match this filter."}
        </div>
      ) : (
        <div className="ar-runs">
          {filtered.map((entry, index) => {
            const boundary = index > 0 && filtered[index - 1].segment !== entry.segment;
            return (
              <Fragment key={String(entry.segment) + ":" + String(entry.run)}>
                {boundary ? <div className="ar-seglabel">Segment {String(entry.segment)}</div> : null}
                <RunRow snapshot={snapshot} entry={entry} />
              </Fragment>
            );
          })}
        </div>
      )}
      {kept.length > 0 ? (
        <div className="ar-note">
          {kept.length} kept of {snapshot.runs.length} runs · best {formatNum(snapshot.bestMetric ?? 0, snapshot.metricUnit)}
        </div>
      ) : null}
    </>
  );
}
