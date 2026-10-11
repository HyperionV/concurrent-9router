"use client";

import { useEffect, useRef, useState } from "react";
import { formatDuration, shortId } from "../format";

const OUTCOME = {
  completed: { label: "completed", color: "var(--status-good)" },
  failed: { label: "failed", color: "var(--status-critical)" },
  timed_out: { label: "timed out", color: "var(--status-warning)" },
  cancelled: { label: "client left", color: "var(--status-neutral)" },
  reconciled: { label: "reconciled", color: "var(--status-neutral)" },
};

function Badge({ color, children }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-text-main">
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} aria-hidden />
      {children}
    </span>
  );
}

/** Ids seen in earlier polls; rows not in it are new and flash once. */
function useNewIds(ids) {
  const seen = useRef(null);
  const [fresh, setFresh] = useState(() => new Set());
  const key = ids.join(",");
  useEffect(() => {
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !seen.current.has(id));
    for (const id of added) seen.current.add(id);
    setFresh(new Set(added));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return fresh;
}

function Table({ headers, children, empty, hasRows }) {
  return (
    <div className="max-h-[320px] overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-border text-[11px] text-text-muted">
            {headers.map(([label, align]) => (
              <th key={label} scope="col" className={`whitespace-nowrap px-2 pb-2 font-medium ${align === "right" ? "text-right" : ""}`}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {hasRows ? children : (
            <tr>
              <td colSpan={headers.length} className="px-2 py-8 text-center text-text-muted">{empty}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default function LiveTape({ live, liveReceivedAt, now }) {
  const [tab, setTab] = useState("active");
  const active = live?.active.attempts || [];
  const queued = live?.queue.requests || [];
  const tape = live?.tape || [];
  const freshTape = useNewIds(tape.map((a) => a.id));

  // Server and browser clocks may disagree; measure ages on the server's clock.
  const skewMs = live ? liveReceivedAt - Date.parse(live.generatedAt) : 0;
  const ageOf = (iso) => (iso ? Math.max(0, now - skewMs - Date.parse(iso)) : null);

  const tabs = [
    ["active", "In flight", live?.active.count ?? 0],
    ["queue", "Queue", live?.queue.count ?? 0],
    ["tape", "Finished", tape.length],
  ];
  const row = "border-b border-border/60 transition-colors hover:bg-[var(--row-hover)]";

  return (
    <section className="dispatcher-panel p-4" aria-label="Live activity">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.06]" role="tablist" aria-label="Live activity">
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                tab === key ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"
              }`}
            >
              {label} <span className="num text-text-muted">{count}</span>
            </button>
          ))}
        </div>
        <span className="text-[11px] text-text-muted">
          {tab === "tape" ? `latest ${tape.length} finished attempts` : "updates every 3s"}
        </span>
      </div>

      {tab === "active" && (
        <Table
          headers={[["Attempt"], ["Model"], ["Account"], ["State"], ["Path"], ["Queue wait", "right"], ["First token", "right"], ["Running", "right"]]}
          hasRows={active.length > 0}
          empty="Nothing in flight"
        >
          {active.map((a) => (
            <tr key={a.id} className={row}>
              <td className="num px-2 py-1.5 text-text-muted" title={a.id}>{shortId(a.id)}</td>
              <td className="px-2 py-1.5 text-text-main">{a.modelId}</td>
              <td className="num px-2 py-1.5 text-text-muted" title={a.connectionId}>{shortId(a.connectionId, 8)}</td>
              <td className="px-2 py-1.5">
                <Badge color={a.state === "streaming" ? "var(--viz-1)" : "var(--status-warning)"}>{a.state}</Badge>
              </td>
              <td className="px-2 py-1.5 text-text-muted">{a.pathMode || "direct"}</td>
              <td className="num px-2 py-1.5 text-right text-text-muted">{formatDuration(a.queueWaitMs)}</td>
              <td className="num px-2 py-1.5 text-right text-text-main">{a.ttftMs === null ? "waiting" : formatDuration(a.ttftMs)}</td>
              <td className="num px-2 py-1.5 text-right text-text-main">{formatDuration(ageOf(a.leasedAt))}</td>
            </tr>
          ))}
        </Table>
      )}

      {tab === "queue" && (
        <Table
          headers={[["Request"], ["Model"], ["Format"], ["Waiting", "right"]]}
          hasRows={queued.length > 0}
          empty="Queue is empty: every request found a free slot"
        >
          {queued.map((r) => (
            <tr key={r.id} className={row}>
              <td className="num px-2 py-1.5 text-text-muted" title={r.id}>{shortId(r.id)}</td>
              <td className="px-2 py-1.5 text-text-main">{r.modelId}</td>
              <td className="px-2 py-1.5 text-text-muted">{r.sourceFormat || "—"} → {r.targetFormat || "—"}</td>
              <td className="num px-2 py-1.5 text-right" style={{ color: "var(--status-warning)" }}>{formatDuration(ageOf(r.queuedAt))}</td>
            </tr>
          ))}
        </Table>
      )}

      {tab === "tape" && (
        <Table
          headers={[["Finished", "right"], ["Model"], ["Account"], ["Outcome"], ["Reason"], ["Queue wait", "right"], ["First token", "right"], ["Total", "right"]]}
          hasRows={tape.length > 0}
          empty="No finished attempts in the last 24 hours"
        >
          {tape.map((a) => {
            const outcome = OUTCOME[a.state] || { label: a.state, color: "var(--status-neutral)" };
            return (
              <tr key={a.id} className={`${row} ${freshTape.has(a.id) ? "row-new" : ""}`}>
                <td className="num px-2 py-1.5 text-right text-text-muted">{formatDuration(ageOf(a.finishedAt))} ago</td>
                <td className="px-2 py-1.5 text-text-main">{a.modelId}</td>
                <td className="num px-2 py-1.5 text-text-muted" title={a.connectionId}>{shortId(a.connectionId, 8)}</td>
                <td className="px-2 py-1.5"><Badge color={outcome.color}>{outcome.label}</Badge></td>
                <td className="px-2 py-1.5 text-text-muted">{a.terminalReason || "—"}</td>
                <td className="num px-2 py-1.5 text-right text-text-muted">{formatDuration(a.queueWaitMs)}</td>
                <td className="num px-2 py-1.5 text-right text-text-main">{formatDuration(a.ttftMs)}</td>
                <td className="num px-2 py-1.5 text-right text-text-main">{formatDuration(a.durationMs)}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </section>
  );
}
