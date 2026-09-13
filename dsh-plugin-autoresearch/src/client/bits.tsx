/** Small shared atoms: status dots, action icons, status chips. */

import type { ReactNode } from "react";

export function StatusDot(props: { state: string; className?: string }): ReactNode {
  return <span className={"ar-dot ar-" + props.state + (props.className !== undefined ? " " + props.className : "")} />;
}

export function IconPause(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="3.4" y="2.4" width="3.4" height="11.2" rx="1.3" fill="currentColor" />
      <rect x="9.2" y="2.4" width="3.4" height="11.2" rx="1.3" fill="currentColor" />
    </svg>
  );
}

export function IconStop(): ReactNode {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.6" fill="currentColor" /></svg>;
}

export function IconPlay(): ReactNode {
  return <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M4.6 2.9v10.2a.7.7 0 0 0 1.06.6l8.1-5.1a.7.7 0 0 0 0-1.2l-8.1-5.1a.7.7 0 0 0-1.06.6z" fill="currentColor" /></svg>;
}

export function IconDiff(): ReactNode {
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

export function IconLogs(): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 1.8h5.1L12.9 5.5v8.7a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.8a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M9.1 1.8v3.7h3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5.4 8.2h5.2M5.4 11h5.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function IconChevron(): ReactNode {
  return <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function Chip(props: { status: string }): ReactNode {
  const chipClass = props.status === "keep" ? "ar-keep" : props.status === "discard" ? "ar-discard" : props.status === "crash" ? "ar-crash" : "ar-checks";
  return <span className={"ar-chip " + chipClass}>{props.status === "checks_failed" ? "checks" : props.status === "discard" ? "discarded" : props.status}</span>;
}
