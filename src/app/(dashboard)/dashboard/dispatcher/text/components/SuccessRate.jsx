"use client";

import { formatPercent } from "../format";

/** Success rate with a status dot; the counts behind it are in the tooltip. */
export default function SuccessRate({ dispatch }) {
  const rate = dispatch.successRate;
  const color =
    rate === null ? "var(--color-text-muted)" : rate >= 0.98 ? "var(--status-good)" : rate >= 0.9 ? "var(--status-warning)" : "var(--status-critical)";
  return (
    <span title={`${dispatch.completed} completed · ${dispatch.failed} failed · ${dispatch.timedOut} timed out · ${dispatch.cancelled} client left`}>
      <span style={{ color }} aria-hidden>● </span>
      <span className="text-text-main">{formatPercent(rate)}</span>
    </span>
  );
}
