/** Run history row (expandable detail) and the live running card. */

import { useState } from "react";
import type { ReactNode } from "react";
import { formatElapsed, formatNum, humanizeMetricKey, splitRunText } from "../../shared/format";
import type { ExperimentSnapshot, RunEntry } from "./store";
import { bestDelta } from "../../entities/derive";
import { Chip, IconChevron, IconDiff, IconLogs, StatusDot } from "../../shared/bits";

export function RunRow(props: { snapshot: ExperimentSnapshot; entry: RunEntry }): ReactNode {
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

export function RunningCard(props: { snapshot: ExperimentSnapshot; tail?: string; now: number }): ReactNode {
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
