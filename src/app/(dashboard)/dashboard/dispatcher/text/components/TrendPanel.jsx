"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatClock, formatCount, formatDuration, formatPercent } from "../format";

const VIEWS = {
  outcomes: {
    label: "Outcomes",
    caption: "Dispatched attempts per step, by how they ended",
    format: formatCount,
    series: [
      { key: "completed", label: "Completed", color: "var(--status-good)" },
      { key: "failed", label: "Failed", color: "var(--status-critical)" },
      { key: "timedOut", label: "Timed out", color: "var(--status-warning)" },
      { key: "cancelled", label: "Client left", color: "var(--status-neutral)" },
    ],
  },
  latency: {
    label: "Latency",
    caption: "Percentiles are histogram bin upper bounds (≤)",
    format: formatDuration,
    series: [
      { key: "ttftP50Ms", label: "First token p50", color: "var(--viz-1)" },
      { key: "ttftP95Ms", label: "First token p95", color: "var(--viz-2)" },
      { key: "queueWaitP95Ms", label: "Queue wait p95", color: "var(--viz-3)" },
      { key: "durationAvgMs", label: "End-to-end avg", color: "var(--viz-4)" },
    ],
  },
  tokens: {
    label: "Tokens",
    caption: "All provider traffic from the usage log",
    format: formatCount,
    series: [
      { key: "cachedTokens", label: "Cached prompt", color: "var(--viz-1)" },
      { key: "uncachedPromptTokens", label: "Uncached prompt", color: "var(--viz-3)" },
      { key: "completionTokens", label: "Output", color: "var(--viz-2)" },
    ],
  },
};

const axisProps = {
  tick: { fontSize: 11, fill: "var(--axis-ink)" },
  tickLine: false,
  axisLine: false,
};

function CrosshairTooltip({ active, payload, label, range, format, extra }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="dispatcher-panel min-w-[180px] px-3 py-2 text-xs shadow-lg">
      <div className="num mb-1.5 font-medium text-text-main">{formatClock(label, range)}</div>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-text-muted">
            <span className="h-2 w-2 rounded-sm" style={{ background: entry.color }} aria-hidden />
            {entry.name}
          </span>
          <span className="num font-medium text-text-main">
            {entry.value === null ? "—" : format(entry.value)}
          </span>
        </div>
      ))}
      {extra?.(point)}
    </div>
  );
}

function Legend({ series, hidden, onToggle }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {series.map((s) => {
        const off = hidden.has(s.key);
        return (
          <button
            key={s.key}
            type="button"
            onClick={() => onToggle(s.key)}
            aria-pressed={!off}
            className={`flex items-center gap-1.5 text-[11px] transition-opacity ${off ? "opacity-40" : "opacity-100"} text-text-muted hover:text-text-main`}
          >
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

export default function TrendPanel({ timeline, range, loading }) {
  const [view, setView] = useState("outcomes");
  const [hidden, setHidden] = useState(() => new Set());
  const config = VIEWS[view];

  const data = useMemo(
    () =>
      timeline.map((point) => {
        const idle = point.attempts === 0;
        return {
          ...point,
          // No attempts in a step means no latency to plot, not zero latency.
          ttftP50Ms: idle ? null : point.ttftP50Ms,
          ttftP95Ms: idle ? null : point.ttftP95Ms,
          queueWaitP95Ms: idle ? null : point.queueWaitP95Ms,
          durationAvgMs: idle ? null : point.durationAvgMs,
          uncachedPromptTokens: Math.max(0, point.promptTokens - point.cachedTokens),
        };
      }),
    [timeline],
  );
  const hasData = data.some((p) => p.attempts > 0 || p.requests > 0);

  const toggle = (key) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const visible = config.series.filter((s) => !hidden.has(s.key));
  const tooltip = (format, extra) => (
    <Tooltip
      cursor={{ stroke: "var(--axis-ink)", strokeDasharray: "3 3", fill: "var(--panel-inset)" }}
      content={<CrosshairTooltip range={range} format={format} extra={extra} />}
      isAnimationActive={false}
    />
  );
  const xAxis = (
    <XAxis dataKey="timestamp" tickFormatter={(t) => formatClock(t, range)} minTickGap={48} {...axisProps} />
  );
  const grid = <CartesianGrid stroke="var(--grid)" vertical={false} />;

  let chart;
  if (view === "outcomes") {
    chart = (
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={1}>
        {grid}
        {xAxis}
        <YAxis tickFormatter={formatCount} width={44} allowDecimals={false} {...axisProps} />
        {tooltip(formatCount)}
        {visible.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="outcomes" fill={s.color} isAnimationActive={false} />
        ))}
        <Brush dataKey="timestamp" height={18} stroke="var(--axis-ink)" fill="transparent" tickFormatter={(t) => formatClock(t, range)} travellerWidth={8} />
      </BarChart>
    );
  } else if (view === "latency") {
    chart = (
      <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        {grid}
        {xAxis}
        <YAxis tickFormatter={formatDuration} width={52} {...axisProps} />
        {tooltip(formatDuration, (point) => (
          <div className="num mt-1 border-t border-border pt-1 text-[11px] text-text-muted">
            {formatCount(point.attempts)} attempts in step
          </div>
        ))}
        {visible.map((s) => (
          <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} type="monotone" />
        ))}
        <Brush dataKey="timestamp" height={18} stroke="var(--axis-ink)" fill="transparent" tickFormatter={(t) => formatClock(t, range)} travellerWidth={8} />
      </LineChart>
    );
  } else {
    chart = (
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        {grid}
        {xAxis}
        <YAxis tickFormatter={formatCount} width={48} {...axisProps} />
        {tooltip(formatCount, (point) => (
          <div className="num mt-1 border-t border-border pt-1 text-[11px] text-text-muted">
            cache hit {formatPercent(point.cacheHitRate)} · {formatCount(point.requests)} requests
          </div>
        ))}
        {visible.map((s) => (
          <Area key={s.key} dataKey={s.key} name={s.label} stackId="tokens" stroke={s.color} fill={s.color} fillOpacity={0.35} strokeWidth={1.5} isAnimationActive={false} type="monotone" />
        ))}
        <Brush dataKey="timestamp" height={18} stroke="var(--axis-ink)" fill="transparent" tickFormatter={(t) => formatClock(t, range)} travellerWidth={8} />
      </AreaChart>
    );
  }

  return (
    <section className="dispatcher-panel p-4" aria-label="Trends">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-lg bg-black/[0.04] p-0.5 dark:bg-white/[0.06]" role="tablist" aria-label="Trend view">
          {Object.entries(VIEWS).map(([key, v]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={view === key}
              onClick={() => {
                setView(key);
                setHidden(new Set());
              }}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                view === key ? "bg-surface text-text-main shadow-sm" : "text-text-muted hover:text-text-main"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>
        <Legend series={config.series} hidden={hidden} onToggle={toggle} />
      </div>
      <p className="mt-2 text-[11px] text-text-muted">{config.caption}</p>
      <div className={`mt-2 h-[300px] w-full min-w-0 transition-opacity ${loading && !hasData ? "opacity-50" : ""}`}>
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            {chart}
          </ResponsiveContainer>
        ) : (
          <div className="flex h-full items-center justify-center rounded-lg bg-[var(--panel-inset)] text-xs text-text-muted">
            {loading ? "Loading…" : "No traffic in this range"}
          </div>
        )}
      </div>
    </section>
  );
}
