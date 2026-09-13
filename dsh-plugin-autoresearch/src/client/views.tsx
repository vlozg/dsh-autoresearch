/**
 * Dashboard overlay (shell.overlay seat) and the three keyed toolviews.
 * The overlay is the phone-friendly carrier: a floating capsule with the
 * live loop state, expanding into a scrollable panel with stats, the running
 * tail, the run table, and stop/resume controls.
 */

import { Fragment, type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { formatAgo, formatElapsed, formatNum, humanizeMetricKey, splitRunText } from "./format";
import { parseInitText, parseLogText, parseRunText } from "./parse";
import {
  type AutoresearchClientStore,
  type AutoresearchView,
  type ExperimentSnapshot,
  type RunEntry,
  type SessionView,
} from "./store";

// ---------------------------------------------------------------------------
// Small shared atoms
// ---------------------------------------------------------------------------

function StatusDot(props: { state: string; className?: string }): ReactNode {
  return <span className={"ar-dot ar-" + props.state + (props.className !== undefined ? " " + props.className : "")} />;
}

function IconPause(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="3.4" y="2.4" width="3.4" height="11.2" rx="1.3" fill="currentColor" />
      <rect x="9.2" y="2.4" width="3.4" height="11.2" rx="1.3" fill="currentColor" />
    </svg>
  );
}

function IconStop(): ReactNode {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.6" fill="currentColor" /></svg>;
}

function IconPlay(): ReactNode {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4.6 2.9v10.2a.7.7 0 0 0 1.06.6l8.1-5.1a.7.7 0 0 0 0-1.2l-8.1-5.1a.7.7 0 0 0-1.06.6z" fill="currentColor" /></svg>;
}

function IconDiff(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="4.2" cy="3.4" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4.2" cy="12.6" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="11.8" cy="3.4" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.2 5.3v3.1a2.6 2.6 0 0 0 2.6 2.6h3.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M11.8 5.3v1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconLogs(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 1.8h5.1L12.9 5.5v8.7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9.1 1.8v3.7h3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5.4 8.2h5.2M5.4 11h5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconChevron(): ReactNode {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function Chip(props: { status: string }): ReactNode {
  const chipClass = props.status === "keep" ? "ar-keep" : props.status === "discard" ? "ar-discard" : props.status === "crash" ? "ar-crash" : "ar-checks";
  return <span className={"ar-chip " + chipClass}>{props.status === "checks_failed" ? "checks" : props.status === "discard" ? "discarded" : props.status}</span>;
}

function confidenceClass(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined) return "";
  return confidence >= 2 ? "ar-strong" : "";
}

const subscribeNever = (): (() => void) => () => {};
const snapshotNever = (): boolean => false;

interface RunDelta {
  label: string;
  good: boolean;
}

/** Delta vs the best kept result before this run: "+10.4% worse" / "-2.8% better". */
function bestDelta(snapshot: ExperimentSnapshot, entry: RunEntry): RunDelta | null {
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

/** Short scan title + remainder finding from a free-text run description. */
function loopState(snapshot: ExperimentSnapshot): { state: string; label: string } {
  if (snapshot.running !== null) return { state: "running", label: snapshot.running.phase === "checks" ? "checking" : "running" };
  if (snapshot.loop) return { state: "live", label: "loop on" };
  if (snapshot.loopStopReason !== null) return { state: "idle", label: "loop off" };
  return { state: "off", label: "idle" };
}

/** Right-aligned loop/run badges for the carrier header row. */
function SessionBadges(props: { snapshot: ExperimentSnapshot }): ReactNode {
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

/** "workdir · metric · Segment n · updated Xm ago" line under the session title. */
function sessionSubtitle(snapshot: ExperimentSnapshot, now: number): string {
  const workName = snapshot.workDir.split("/").filter(Boolean).pop() ?? snapshot.workDir;
  const parts = [workName, snapshot.metricLabel ?? snapshot.metricName, "Segment " + String(snapshot.currentSegment)];
  const lastRun = snapshot.runs.length > 0 ? snapshot.runs[snapshot.runs.length - 1].timestamp : null;
  if (lastRun !== null) parts.push("updated " + formatAgo(lastRun, now));
  if (snapshot.loopStopReason !== null) parts.push(snapshot.loopStopReason);
  return parts.join(" · ");
}

/** "Detect past autoresearch sessions" button + discovered-session listing. */
function DetectPanel(props: { store: AutoresearchClientStore; view: AutoresearchView; sessionId?: string }): ReactNode {
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

function RunRow(props: { snapshot: ExperimentSnapshot; entry: RunEntry }): ReactNode {
  const { snapshot, entry } = props;
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const delta = bestDelta(snapshot, entry);
  const conf = entry.confidence;
  const parts = splitRunText(entry.description);
  const hasTitle = entry.title !== undefined && entry.title !== "";
  const title = hasTitle ? entry.title : parts.title;
  const finding = entry.summary !== undefined && entry.summary !== ""
    ? entry.summary
    : hasTitle ? entry.description : parts.finding;
  const pairs: { name: string; unit: string; value: number }[] = [];
  for (const def of snapshot.secondaryMetrics) {
    const value = entry.metrics[def.name];
    if (typeof value === "number" && Number.isFinite(value)) pairs.push({ name: def.name, unit: def.unit, value });
  }
  const visible = showAll ? pairs : pairs.slice(0, 6);
  return (
    <div className={"ar-run" + (open ? " ar-open" : "")}>
      <button
        type="button"
        className="ar-run-head"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="ar-run-no">#{entry.run}</span>
        <Chip status={entry.status} />
        <span className="ar-run-metricrow">
          <span className="ar-run-metric">{formatNum(entry.metric, snapshot.metricUnit)}</span>
          {delta !== null
            ? <span className={"ar-run-delta " + (delta.good ? "ar-good-stat" : "ar-bad-stat")}>{delta.label}</span>
            : null}
        </span>
        <span className="ar-run-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open ? null : (
        <div className="ar-run-desc" onClick={() => setOpen(true)}>
          <span className="ar-run-title">{title}</span>
        </div>
      )}
      {open ? (
        <div className="ar-run-detail">
          <div className="ar-run-detail-title">{title}</div>
          {finding !== "" ? <div className="ar-run-detail-desc">{finding}</div> : null}
          {pairs.length > 0 ? (
            <div className="ar-run-keys">
              <div className="ar-run-keys-h">Key metrics</div>
              <div className="ar-run-keys-grid">
                {visible.map((m) => (
                  <div key={m.name} className="ar-run-kv">
                    <span className="ar-run-kv-k">{humanizeMetricKey(m.name)}</span>
                    <span className="ar-run-kv-v">{formatNum(m.value, m.unit)}</span>
                  </div>
                ))}
              </div>
              <div className="ar-run-keys-foot">
                {pairs.length > 6 ? (
                  <button type="button" className={"ar-run-all" + (showAll ? " ar-on" : "")} onClick={() => setShowAll((prev) => !prev)}>
                    <IconChevron />
                    {showAll ? "Show fewer metrics" : "Show all metrics"}
                  </button>
                ) : <span />}
                <div className="ar-run-acts">
                  <button type="button" className="ar-run-act" title="Coming soon" onClick={(event) => event.stopPropagation()}>
                    <IconDiff /> View diff
                  </button>
                  <button type="button" className="ar-run-act" title="Coming soon" onClick={(event) => event.stopPropagation()}>
                    <IconLogs /> Logs
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="ar-run-acts">
              <button type="button" className="ar-run-act" title="Coming soon" onClick={(event) => event.stopPropagation()}>
                <IconDiff /> View diff
              </button>
              <button type="button" className="ar-run-act" title="Coming soon" onClick={(event) => event.stopPropagation()}>
                <IconLogs /> Logs
              </button>
            </div>
          )}
          <div className="ar-run-foot">
            {[
              entry.commit !== "" ? entry.commit.slice(0, 7) : null,
              new Date(entry.timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }),
              "segment " + String(entry.segment),
              conf !== null ? conf.toFixed(1) + "×" : null,
            ]
              .filter((part): part is string => part !== null)
              .join(" · ")}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function RunningCard(props: { snapshot: ExperimentSnapshot; tail?: string; now: number }): ReactNode {
  const { snapshot, now } = props;
  const running = snapshot.running;
  if (running === null) return null;
  const elapsed = formatElapsed(Math.max(0, (now - running.startedAt) / 1000));
  const tail = props.tail ?? "";
  return (
    <div className="ar-running">
      <div className="ar-running-head">
        <StatusDot state="running" />
        <span>{running.phase === "checks" ? "Running checks" : "Running benchmark"}</span>
        <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>{elapsed}</span>
      </div>
      <div className="ar-running-cmd">{running.command}</div>
      {tail !== "" ? <div className="ar-tail">{tail.length > 4000 ? tail.slice(-4000) : tail}</div> : null}
    </div>
  );
}

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

function SessionPanel(props: { session: SessionView; tail?: string; now: number }): ReactNode {
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

// ---------------------------------------------------------------------------
// better-sidebar tab
// ---------------------------------------------------------------------------

export interface SidebarTabViewProps {
  store: AutoresearchClientStore;
  /** Conversation session id from the sidebar scope; null = show any. */
  scopeId: string;
}

/** dsh-better-sidebar tab body: the full dashboard for one conversation. */
export function SidebarTabView(props: SidebarTabViewProps): ReactNode {
  const { store } = props;
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot);
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

  const session =
    view.sessions.find((item) => item.snapshot.sessionId === props.scopeId) ?? view.sessions[0];
  const live = session !== undefined && session.snapshot.running !== null;
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  useEffect(() => {
    if (live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, [live]);

  if (session === undefined) {
    return (
      <div className="ar-root ar-tabroot">
        <div className="ar-empty">
          {view.subscribed
            ? "No experiment sessions yet. Ask the agent to run init_experiment."
            : "Connecting to the experiment feed…"}
        </div>
        <DetectPanel store={store} view={view} sessionId={props.scopeId} />
      </div>
    );
  }

  const headline = loopState(session.snapshot);
  const runAction = async (kind: "stop" | "resume"): Promise<void> => {
    setBusy(kind);
    setActionError(null);
    const result =
      kind === "stop"
        ? await store.stopExperiment(session.snapshot.sessionId)
        : await store.resumeExperiment(session.snapshot.sessionId);
    setBusy(null);
    if (!result.ok) setActionError(result.error ?? "action failed");
  };

  return (
    <div className="ar-root ar-tabroot">
      <div className="ar-tabhead">
        <div className="ar-head-main">
          <div className="ar-title">{session.snapshot.name}</div>
          <div className="ar-subtitle">{view.subscribed ? sessionSubtitle(session.snapshot, now) : "reconnecting…"}</div>
        </div>
        <SessionBadges snapshot={session.snapshot} />
      </div>
      {view.subscribed ? null : <div className="ar-connwarn">Feed disconnected — retrying…</div>}
      <SessionPanel session={session} now={now} />
      <DetectPanel store={store} view={view} sessionId={props.scopeId} />
      {actionError !== null ? <div className="ar-note">⚠ {actionError}</div> : null}
      <div className="ar-actions ar-tabfoot">
        {session.snapshot.loop && session.snapshot.running === null ? (
          <button type="button" className="ar-btn" disabled={busy !== null} title="Stop the loop — resume any time with Resume loop" onClick={() => void runAction("stop")}>
            <IconPause /> {busy === "stop" ? "Pausing…" : "Pause"}
          </button>
        ) : null}
        {session.snapshot.running !== null ? (
          <button type="button" className="ar-btn ar-danger" disabled={busy !== null} onClick={() => void runAction("stop")}>
            <IconStop /> {busy === "stop" ? "Stopping…" : "Stop run"}
          </button>
        ) : !session.snapshot.loop ? (
          <button type="button" className="ar-btn ar-good" disabled={busy !== null} onClick={() => void runAction("resume")}>
            <IconPlay /> {busy === "resume" ? "Resuming…" : "Resume loop"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolviews
// ---------------------------------------------------------------------------

const RUN_CHIP: Record<string, { label: string; cls: string }> = {
  passed: { label: "PASS", cls: "ar-keep" },
  failed: { label: "FAIL", cls: "ar-crash" },
  timeout: { label: "TIMEOUT", cls: "ar-discard" },
  aborted: { label: "ABORTED", cls: "ar-discard" },
  checks_timeout: { label: "CHECKS ⏰", cls: "ar-checks" },
  checks_failed: { label: "CHECKS ✗", cls: "ar-checks" },
  unknown: { label: "RUN", cls: "ar-checks" },
};

/** run_experiment toolview: status chip, parsed metric chips, tail. */
export function RunToolView(props: { text: string; running: boolean; command: string | null }): ReactNode {
  const model = parseRunText(props.text);
  const chip = RUN_CHIP[model.kind] ?? RUN_CHIP.unknown;
  const summary = model.headline !== "" ? model.headline : props.running ? "running…" : "";
  return (
    <div className="ar-tool" data-tool="run_experiment" data-state={props.running ? "running" : model.kind}>
      <div className="ar-tool-head">
        <StatusDot state={props.running ? "running" : model.kind === "passed" ? "done" : model.kind === "unknown" ? "off" : "error"} />
        <span className="ar-tool-title">run_experiment</span>
        <span className="ar-tool-summary">{summary}</span>
      </div>
      <div className="ar-tool-body">
        {props.running && props.command !== null ? <div className="ar-running-cmd">{props.command}</div> : null}
        {model.durationSeconds !== null ? <div className="ar-line">⏱ {formatElapsed(model.durationSeconds)}{model.exitCode !== null ? <span className="ar-dim"> · exit {String(model.exitCode)}</span> : null}</div> : null}
        {model.bestLine !== null ? <div className="ar-line ar-dim">{model.bestLine}</div> : null}
        {model.parsed.length > 0 ? (
          <div className="ar-chiprow">
            {model.parsed.map((metric) => (
              <span key={metric.name} className={"ar-chip " + (metric.name === model.primaryName ? "ar-keep" : "ar-checks")}>
                {metric.name}={String(metric.value)}
              </span>
            ))}
          </div>
        ) : null}
        {model.tail !== "" ? (
          <details className="ar-tool-details">
            <summary>{props.running ? "Live output" : model.truncated ? "Output (truncated)" : "Output"}</summary>
            <div className="ar-tail">{model.tail}</div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

/** init_experiment toolview: what session/metric was set up. */
export function InitToolView(props: { text: string; args: Record<string, unknown> | null }): ReactNode {
  const model = parseInitText(props.text);
  const args = props.args ?? {};
  const metricName = typeof args.metric_name === "string" ? args.metric_name : null;
  const direction = typeof args.direction === "string" ? args.direction : "lower";
  const unit = typeof args.metric_unit === "string" ? args.metric_unit : "";
  const name = model.name ?? (typeof args.name === "string" ? args.name : null);
  return (
    <div className="ar-tool">
      <div className="ar-tool-head">
        <StatusDot state={model.ok ? "done" : "error"} />
        <span className="ar-tool-title">init_experiment</span>
        <span className="ar-tool-summary">{model.ok ? "session initialized" : "init failed"}</span>
      </div>
      <div className="ar-tool-body">
        {name !== null ? <div className="ar-line">🔬 {name}</div> : null}
        {metricName !== null ? (
          <div className="ar-line">
            📊 {metricName}
            {unit !== "" ? unit : ""} <span className="ar-dim">({direction} is better)</span>
          </div>
        ) : null}
        {!model.ok ? <div className="ar-line">{model.error}</div> : null}
      </div>
    </div>
  );
}

/** log_experiment toolview: verdict, delta, confidence, git. */
export function LogToolView(props: { text: string }): ReactNode {
  const model = parseLogText(props.text);
  return (
    <div className="ar-tool">
      <div className="ar-tool-head">
        <StatusDot state={model.status === "keep" ? "done" : model.status === "unknown" ? "off" : "error"} />
        <span className="ar-tool-title">log_experiment</span>
        <span className="ar-tool-summary">
          {model.run !== null ? "#" + String(model.run) + " " : ""}
          {model.status}
        </span>
      </div>
      <div className="ar-tool-body">
        <div className="ar-chiprow">
          <Chip status={model.status === "unknown" ? "crash" : model.status} />
          {model.description !== "" ? <span className="ar-line">{model.description}</span> : null}
        </div>
        {model.baselineLine !== null ? (
          <div className="ar-line ar-dim">
            {model.baselineLine.replace(model.deltaLine !== null ? " | " + model.deltaLine : "", "")}
            {model.deltaLine !== null ? <span className="ar-git"> · this: {model.deltaLine}</span> : null}
          </div>
        ) : null}
        {model.secondaryLine !== null ? <div className="ar-line ar-dim">{model.secondaryLine}</div> : null}
        {model.confidenceLine !== null ? (
          <div className={"ar-line" + (model.confidence !== null && model.confidence >= 2 ? "" : " ar-dim")}>{model.confidenceLine}</div>
        ) : null}
        {model.gitLine !== null ? <div className="ar-git">{model.gitLine}</div> : null}
        {model.limitReached ? <div className="ar-line">🛑 Segment limit reached — loop stopped.</div> : null}
      </div>
    </div>
  );
}
