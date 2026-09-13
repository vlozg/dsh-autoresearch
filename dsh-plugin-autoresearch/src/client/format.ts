/** Client-side number/time formatters mirroring the host's display units. */

export function formatNum(value: number, unit: string): string {
  let text: string;
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 0.01 || abs >= 100000)) text = value.toExponential(2);
  else if (Number.isInteger(value)) text = String(value);
  else text = String(Math.round(value * 1000) / 1000);
  return unit === "" ? text : text + unit;
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return seconds.toFixed(1) + "s";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes + "m" + String(rest).padStart(2, "0") + "s";
}

export function formatAgo(timestamp: number, now: number): string {
  const delta = Math.max(0, now - timestamp) / 1000;
  if (delta < 60) return Math.floor(delta) + "s ago";
  if (delta < 3600) return Math.floor(delta / 60) + "m ago";
  if (delta < 86400) return Math.floor(delta / 3600) + "h ago";
  return Math.floor(delta / 86400) + "d ago";
}
/**
 * Split a log_experiment description into sidebar title + finding.
 * Prefers the recommended "Title: finding" form; falls back to a
 * word-boundary cut near 72 chars for legacy free-text descriptions.
 */
export function splitRunText(desc: string): { title: string; finding: string } {
  const text = desc.trim();
  const colon = text.indexOf(": ");
  if (colon > 0 && colon <= 80 && /\s/.test(text.slice(0, colon))) {
    return { title: text.slice(0, colon), finding: text.slice(colon + 2) };
  }
  if (text.length <= 72) return { title: text, finding: "" };
  const cut = text.lastIndexOf(" ", 72);
  const title = cut > 32 ? text.slice(0, cut) : text.slice(0, 72);
  return { title, finding: text.slice(title.length).replace(/^[\s,;:\u2013\u2014-]+/, "") };
}
