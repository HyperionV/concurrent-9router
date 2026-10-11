"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import {
  PREVIOUS_LABELS,
  formatAge,
  formatAtMost,
  formatCount,
  formatDuration,
  formatPercent,
  relativeChange,
} from "../format";

/** Tiny inline trend line; null points (no data in a step) break the line. */
function Sparkline({ values, color = "var(--viz-1)" }) {
  const points = values.map((v, i) => [i, Number.isFinite(v) ? v : null]);
  const finite = points.filter(([, v]) => v !== null).map(([, v]) => v);
  if (finite.length < 2) return <div className="h-7" aria-hidden />;
  const max = Math.max(...finite);
  const min = Math.min(0, ...finite);
  const span = max - min || 1;
  const width = 120;
  const height = 28;
  const x = (i) => (i / Math.max(1, values.length - 1)) * width;
  const y = (v) => height - 2 - ((v - min) / span) * (height - 4);
  let d = "";
  let penDown = false;
  for (const [i, v] of points) {
    if (v === null) {
      penDown = false;
      continue;
    }
    d += `${penDown ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    penDown = true;
  }
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-7 w-full" aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * @param {{change: number|null, goodWhen: "up"|"down"|null, unit?: "pct"|"pp"}} props
 *   change is relative (pct) or absolute ratio points (pp)
 */
function Delta({ change, goodWhen, unit = "pct", range }) {
  if (change === null || Math.abs(change) < 0.0005) {
    return (
      <span className="flex items-center gap-0.5 text-[11px] text-text-muted">
        <Minus className="h-3 w-3" aria-hidden />
        {change === null ? "no baseline" : `flat vs ${PREVIOUS_LABELS[range]}`}
      </span>
    );
  }
  const up = change > 0;
  const tone = goodWhen === null ? "neutral" : (up === (goodWhen === "up") ? "good" : "bad");
  const color = tone === "good" ? "var(--status-good)" : tone === "bad" ? "var(--status-critical)" : "var(--color-text-muted)";
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  const magnitude = unit === "pp"
    ? `${Math.abs(change * 100).toFixed(1)}pp`
    : `${Math.abs(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%`;
  return (
    <span className="num flex items-center gap-0.5 text-[11px] font-medium" style={{ color }}>
      <Icon className="h-3 w-3" aria-hidden />
      <span>{up ? "+" : "−"}{magnitude}</span>
      <span className="font-normal text-text-muted">vs {PREVIOUS_LABELS[range]}</span>
    </span>
  );
}

function Tile({ label, value, delta, detail, spark, children }) {
  return (
    <div className="dispatcher-panel flex min-w-0 flex-col gap-1.5 p-3.5">
      <span className="text-[11px] font-medium text-text-muted">{label}</span>
      <span className="num value-tick truncate text-[22px] font-semibold leading-none tracking-tight text-text-main">
        {value}
      </span>
      {delta}
      {children}
      <div className="mt-auto pt-1">{spark}</div>
      <span className="num truncate text-[11px] text-text-muted" title={typeof detail === "string" ? detail : undefined}>
        {detail}
      </span>
    </div>
  );
}

export default function KpiStrip({ history, live, range, now }) {
  const current = history?.aggregates.current;
  const previous = history?.aggregates.previous;
  const timeline = history?.timeline || [];
  const series = (key) => timeline.map((point) => point[key]);
  // A step with no attempts has no latency, not a latency of zero.
  const latencySeries = (key) => timeline.map((point) => (point.attempts > 0 ? point[key] : null));
  const dispatch = current?.dispatch;
  const traffic = current?.traffic;
  const capacity = live?.capacity;

  const successChange =
    dispatch?.successRate != null && previous?.dispatch.successRate != null
      ? dispatch.successRate - previous.dispatch.successRate
      : null;
  const durationP95 = dispatch?.duration.samples > 0 ? dispatch.duration.p95Ms : null;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      <Tile
        label="Dispatched attempts"
        value={formatCount(dispatch?.attempts)}
        delta={<Delta change={relativeChange(dispatch?.attempts, previous?.dispatch.attempts)} goodWhen={null} range={range} />}
        spark={<Sparkline values={series("attempts")} />}
        detail={`${formatCount(traffic?.requests)} provider requests`}
      />
      <Tile
        label="Success rate"
        value={formatPercent(dispatch?.successRate)}
        delta={<Delta change={successChange} goodWhen="up" unit="pp" range={range} />}
        spark={<Sparkline values={series("successRate")} color="var(--viz-3)" />}
        detail={`${formatCount(dispatch?.failed)} failed · ${formatCount(dispatch?.timedOut)} timed out · ${formatCount(dispatch?.cancelled)} left early`}
      />
      <Tile
        label="Time to first token p95"
        value={formatAtMost(dispatch?.ttft.p95Ms)}
        delta={<Delta change={relativeChange(dispatch?.ttft.p95Ms, previous?.dispatch.ttft.p95Ms)} goodWhen="down" range={range} />}
        spark={<Sparkline values={latencySeries("ttftP95Ms")} color="var(--viz-2)" />}
        detail={`p50 ${formatAtMost(dispatch?.ttft.p50Ms)} · avg ${formatDuration(dispatch?.ttft.avgMs)}`}
      />
      <Tile
        label="End-to-end p95"
        value={durationP95 === null ? formatDuration(dispatch?.duration.avgMs) : formatAtMost(durationP95)}
        delta={<Delta change={relativeChange(dispatch?.duration.avgMs, previous?.dispatch.duration.avgMs)} goodWhen="down" range={range} />}
        spark={<Sparkline values={latencySeries("durationAvgMs")} color="var(--viz-4)" />}
        detail={durationP95 === null ? "average shown; p95 builds up from new traffic" : `avg ${formatDuration(dispatch?.duration.avgMs)}`}
      />
      <Tile
        label="Queue now"
        value={formatCount(live?.queue.count)}
        delta={
          <span className="num text-[11px] text-text-muted">
            {live?.queue.count ? `oldest waiting ${formatDuration(live.queue.oldestAgeMs)}` : "nothing waiting"}
          </span>
        }
        spark={<Sparkline values={latencySeries("queueWaitP95Ms")} color="var(--viz-2)" />}
        detail={`wait p95 ${formatAtMost(dispatch?.queueWait.p95Ms)} over range`}
      />
      <Tile
        label="Tokens"
        value={formatCount(traffic?.totalTokens)}
        delta={<Delta change={relativeChange(traffic?.totalTokens, previous?.traffic.totalTokens)} goodWhen={null} range={range} />}
        spark={<Sparkline values={series("outputTokensPerMinute")} color="var(--viz-1)" />}
        detail={`cache hit ${formatPercent(traffic?.cacheHitRate)} · ${formatCount(traffic?.cachedTokens)} cached`}
      />
      <Tile
        label="Slots in use"
        value={capacity ? `${capacity.activeLeases} / ${capacity.totalCapacity}` : "—"}
        delta={
          <div className="meter mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.min(100, (capacity?.utilization || 0) * 100)}%`,
                background: (capacity?.utilization || 0) >= 0.9 ? "var(--status-critical)" : "var(--color-primary)",
              }}
            />
          </div>
        }
        spark={<div className="h-7" />}
        detail={capacity ? `${capacity.availableLeases} free · ${capacity.activeConnections} accounts · ${capacity.slotsPerConnection}/account` : `updated ${formatAge(null, now)}`}
      />
    </div>
  );
}
