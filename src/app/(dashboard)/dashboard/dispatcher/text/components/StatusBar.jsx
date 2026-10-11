"use client";

import { RefreshCw } from "lucide-react";
import { formatAge } from "../format";
import { LIVE_STALE_AFTER_MS } from "../useDispatcherStatus";

const RANGES = ["1h", "24h", "7d"];

function Segmented({ options, value, onChange, label }) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.06]">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            title={option.label}
            className={`max-w-[11rem] truncate whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              selected
                ? "bg-surface text-text-main shadow-sm"
                : "text-text-muted hover:text-text-main"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function LiveIndicator({ liveReceivedAt, liveError, now }) {
  const ageMs = liveReceivedAt ? now - liveReceivedAt : Infinity;
  const state = liveError && ageMs > LIVE_STALE_AFTER_MS
    ? { color: "var(--status-critical)", text: `Disconnected · last update ${formatAge(liveReceivedAt || null, now)}`, pulse: false }
    : ageMs > LIVE_STALE_AFTER_MS
      ? { color: "var(--status-warning)", text: liveReceivedAt ? `Stale · ${formatAge(liveReceivedAt, now)}` : "Connecting…", pulse: false }
      : { color: "var(--status-good)", text: "Live", pulse: true };
  return (
    <span className="flex items-center gap-1.5 text-xs text-text-muted" title={liveError || undefined} aria-live="polite">
      <span
        className={`h-2 w-2 rounded-full ${state.pulse ? "pulse" : ""}`}
        style={{ background: state.color }}
        aria-hidden
      />
      <span className="num">{state.text}</span>
    </span>
  );
}

export default function StatusBar({
  providers,
  provider,
  onProviderChange,
  range,
  onRangeChange,
  mode,
  liveReceivedAt,
  liveError,
  historyLoading,
  onRefresh,
  now,
}) {
  return (
    // The page scroller has top padding; the strip above the bar covers it so
    // rows never show through the gap while the bar is pinned.
    <div className="sticky top-0 z-20 -mx-1 flex flex-wrap items-center justify-between gap-3 border-b border-border bg-bg px-1 py-2 before:absolute before:inset-x-0 before:bottom-full before:h-10 before:bg-bg">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Provider"
          options={providers.map((p) => ({ value: p.id, label: p.label }))}
          value={provider}
          onChange={onProviderChange}
        />
        {mode && (
          <span
            className={`rounded-md px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
              mode === "managed" ? "bg-primary/10 text-primary" : "bg-black/[0.05] text-text-muted dark:bg-white/[0.08]"
            }`}
            title="Dispatcher mode"
          >
            {mode}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        <LiveIndicator liveReceivedAt={liveReceivedAt} liveError={liveError} now={now} />
        <Segmented
          label="Range"
          options={RANGES.map((r) => ({ value: r, label: r }))}
          value={range}
          onChange={onRangeChange}
        />
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh now"
          className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-black/[0.05] hover:text-text-main dark:hover:bg-white/[0.08]"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${historyLoading ? "animate-spin" : ""}`} />
        </button>
      </div>
    </div>
  );
}
