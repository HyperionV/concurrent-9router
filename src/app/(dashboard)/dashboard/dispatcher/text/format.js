/** Number and time formatting shared by every dispatcher dashboard panel. */

const EMPTY = "—";

export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return EMPTY;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e8 ? 0 : 1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return Math.round(n).toLocaleString();
}

export function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return EMPTY;
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 10_000) return `${(value / 1000).toFixed(2)}s`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/**
 * Latency percentiles come from fixed histogram bins, so a value is the
 * upper bound of the bin the percentile fell in.
 */
export function formatAtMost(ms) {
  return Number(ms) > 0 ? `≤ ${formatDuration(ms)}` : EMPTY;
}

/** @param {number|null} ratio 0..1, or null when there is nothing to measure */
export function formatPercent(ratio, digits = 1) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return EMPTY;
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatAge(timestamp, nowMs) {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.floor((nowMs - new Date(timestamp).getTime()) / 1000));
  if (!Number.isFinite(seconds)) return "never";
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function formatClock(timestamp, range) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (range !== "7d") return time;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

export function shortId(id, length = 10) {
  if (!id) return EMPTY;
  return id.length > length ? `${id.slice(0, length)}…` : id;
}

/**
 * Relative change from previous to current, or null when there is no
 * meaningful baseline (an empty previous period).
 */
export function relativeChange(current, previous) {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) {
    return null;
  }
  if (previous === 0) return null;
  return (current - previous) / previous;
}

export const RANGE_LABELS = { "1h": "last hour", "24h": "last 24 hours", "7d": "last 7 days" };
export const PREVIOUS_LABELS = { "1h": "prev hour", "24h": "prev 24h", "7d": "prev 7d" };
