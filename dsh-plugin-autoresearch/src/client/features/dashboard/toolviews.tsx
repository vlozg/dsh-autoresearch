/**
 * Keyed toolviews: replace the raw JSON of init_experiment / run_experiment /
 * log_experiment tool calls with compact status cards in the conversation.
 */

import type { ReactNode } from "react";
import { formatElapsed } from "../../shared/format";
import { parseInitText, parseLogText, parseRunText } from "../../entities/parse";
import { Chip, StatusDot } from "../../shared/bits";

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
