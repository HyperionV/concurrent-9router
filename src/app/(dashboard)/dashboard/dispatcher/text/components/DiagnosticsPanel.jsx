"use client";

import { formatAge, formatCount, formatDuration } from "../format";

function RankedBars({ title, counts, empty }) {
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, n]) => n));
  return (
    <div className="min-w-0">
      <h4 className="mb-2 text-[11px] font-medium text-text-muted">{title}</h4>
      {entries.length === 0 ? (
        <p className="text-[11px] text-text-muted">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.slice(0, 8).map(([label, n]) => (
            <li key={label} className="num grid grid-cols-[minmax(0,1fr)_64px_40px] items-center gap-2 text-[11px]">
              <span className="truncate text-text-main" title={label}>{label}</span>
              <span className="meter h-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                <span className="block h-full rounded-full bg-[var(--axis-ink)]" style={{ width: `${(n / max) * 100}%` }} />
              </span>
              <span className="text-right text-text-muted">{formatCount(n)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const POLICY_ROWS = [
  ["waitingLimitMs", "Queue wait limit"],
  ["connectTimeoutMs", "Connect timeout"],
  ["ttftTimeoutMs", "First token timeout"],
  ["idleTimeoutMs", "Idle stream timeout"],
  ["attemptDeadlineMs", "Attempt deadline"],
];

/**
 * Why recent attempts ended. Drawn from the newest attempts in the 24-hour
 * ledger (not the selected range), and labelled with the sample it covers.
 */
export default function DiagnosticsPanel({ diagnostics, timeoutPolicy, now }) {
  return (
    <section className="dispatcher-panel p-4" aria-label="Diagnostics">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-text-main">How attempts ended</h3>
        <span className="num text-[11px] text-text-muted">
          {diagnostics
            ? `last ${formatCount(diagnostics.sampleSize)} attempts${diagnostics.oldestInSample ? `, back to ${formatAge(diagnostics.oldestInSample, now)}` : ""}`
            : "loading…"}
        </span>
      </header>
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        <RankedBars title="End reason" counts={diagnostics?.byTerminalReason} empty="No finished attempts yet" />
        <RankedBars title="Timeouts by kind" counts={diagnostics?.byTimeoutKind} empty="No timeouts" />
        <RankedBars title="Transport path" counts={diagnostics?.byPathMode} empty="No attempts yet" />
        <div>
          <h4 className="mb-2 text-[11px] font-medium text-text-muted">Watchdog policy</h4>
          {timeoutPolicy ? (
            <dl className="num flex flex-col gap-1 text-[11px]">
              {POLICY_ROWS.map(([key, label]) => (
                <div key={key} className="flex justify-between gap-2">
                  <dt className="text-text-muted">{label}</dt>
                  <dd className="text-text-main">{formatDuration(timeoutPolicy[key])}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-[11px] text-text-muted">No watchdog for this provider</p>
          )}
        </div>
      </div>
    </section>
  );
}
