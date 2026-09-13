/** dsh-better-sidebar tab body: the full dashboard for one conversation. */

import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AutoresearchClientStore } from "./store";
import { loopState, sessionSubtitle } from "./derive";
import { DetectPanel, SessionBadges, SessionPanel } from "./panel";
import { IconPause, IconPlay, IconStop } from "./bits";

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
