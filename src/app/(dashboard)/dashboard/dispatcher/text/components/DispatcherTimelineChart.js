"use client";

import { useState, useMemo } from "react";
import { Card, Badge, Button } from "@/shared/components";

function formatTimeLabel(isoString, range) {
  if (!isoString) return "";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";

  if (range === "1h") {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (range === "7d") {
    return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "--";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

export default function DispatcherTimelineChart({
  timeline = [],
  range = "24h",
  onRangeChange,
  refreshing = false,
}) {
  const [hoveredIndex, setHoveredIndex] = useState(null);

  const points = useMemo(() => {
    return Array.isArray(timeline) ? timeline : [];
  }, [timeline]);

  // Compute maximums for scaling
  const { maxRequests, maxLatency, totalRequests, avgP95, peakP95 } = useMemo(() => {
    let maxR = 1;
    let maxL = 100;
    let sumR = 0;
    let sumP95 = 0;
    let countP95 = 0;
    let maxP95Val = 0;

    for (const p of points) {
      const r = Number(p.requests) || 0;
      const p95 = Number(p.p95TtftMs) || 0;
      const p50 = Number(p.p50TtftMs) || 0;
      sumR += r;
      if (r > maxR) maxR = r;
      if (p95 > maxL) maxL = p95;
      if (p50 > maxL) maxL = p50;
      if (p95 > 0) {
        sumP95 += p95;
        countP95 += 1;
        if (p95 > maxP95Val) maxP95Val = p95;
      }
    }

    return {
      maxRequests: Math.max(5, maxR),
      maxLatency: Math.max(500, maxL),
      totalRequests: sumR,
      avgP95: countP95 > 0 ? Math.round(sumP95 / countP95) : 0,
      peakP95: maxP95Val,
    };
  }, [points]);

  const hoveredPoint = hoveredIndex !== null && points[hoveredIndex] ? points[hoveredIndex] : null;

  // Dimensions for SVG
  const width = 800;
  const height = 220;
  const paddingLeft = 45;
  const paddingRight = 45;
  const paddingTop = 20;
  const paddingBottom = 35;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const numPoints = points.length;

  const getX = (index) => {
    if (numPoints <= 1) return paddingLeft + chartWidth / 2;
    return paddingLeft + (index / (numPoints - 1)) * chartWidth;
  };

  const getBarHeight = (reqs) => {
    const val = Number(reqs) || 0;
    return (val / maxRequests) * (chartHeight * 0.7); // bars take bottom 70%
  };

  const getLatencyY = (latencyMs) => {
    const val = Number(latencyMs) || 0;
    const clamped = Math.min(maxLatency, Math.max(0, val));
    return paddingTop + chartHeight - (clamped / maxLatency) * chartHeight;
  };

  // Build SVG path for p50 and p95 lines
  const p50Path = useMemo(() => {
    if (numPoints === 0) return "";
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${getX(i)} ${getLatencyY(p.p50TtftMs)}`)
      .join(" ");
  }, [points, numPoints, maxLatency]);

  const p95Path = useMemo(() => {
    if (numPoints === 0) return "";
    return points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${getX(i)} ${getLatencyY(p.p95TtftMs)}`)
      .join(" ");
  }, [points, numPoints, maxLatency]);

  return (
    <Card
      title="Dispatcher Throughput & TTFT Latency Timeline"
      subtitle="Time-series volume and dual-phase tail latency distribution across the selected observation window."
      icon="timeline"
      headerAction={
        <div className="flex items-center gap-1 rounded-lg border border-black/10 bg-black/[0.02] p-1 dark:border-white/10 dark:bg-white/[0.02]">
          {["1h", "24h", "7d"].map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRangeChange?.(r)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-all ${
                range === r
                  ? "bg-primary text-white shadow-xs"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              {r === "1h" ? "Past 1h" : r === "24h" ? "Past 24h" : "Past 7d"}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Metric Summary Badges */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-black/5 pb-3 dark:border-white/5">
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="inline-block size-2.5 rounded-sm bg-primary/30" />
              <span className="text-text-muted">Requests:</span>
              <span className="font-semibold font-mono text-text-main">{totalRequests}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full bg-primary" />
              <span className="text-text-muted">TTFT p50</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-full bg-amber-500" />
              <span className="text-text-muted">TTFT p95</span>
            </div>
            {avgP95 > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-text-muted">Avg p95:</span>
                <span className="font-semibold font-mono text-amber-500">{avgP95} ms</span>
              </div>
            )}
            {peakP95 > 0 && (
              <div className="flex items-center gap-1.5">
                <span className="text-text-muted">Peak p95:</span>
                <span className="font-semibold font-mono text-red-500">{peakP95} ms</span>
              </div>
            )}
          </div>

          {hoveredPoint ? (
            <div className="rounded bg-black/5 px-2.5 py-1 text-xs dark:bg-white/10 flex items-center gap-3">
              <span className="font-mono text-text-muted">
                {formatTimeLabel(hoveredPoint.timestamp, range)}
              </span>
              <span>
                Reqs: <strong className="font-mono">{hoveredPoint.requests}</strong>
              </span>
              <span>
                TTFT p50: <strong className="font-mono text-primary">{hoveredPoint.p50TtftMs || 0}ms</strong>
              </span>
              <span>
                TTFT p95: <strong className="font-mono text-amber-500">{hoveredPoint.p95TtftMs || 0}ms</strong>
              </span>
              <span>
                Queue: <strong className="font-mono text-text-muted">{hoveredPoint.avgQueueWaitMs || 0}ms</strong>
              </span>
            </div>
          ) : (
            <span className="text-xs text-text-muted">Hover over chart points to inspect interval details</span>
          )}
        </div>

        {/* SVG Chart */}
        {points.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-black/10 py-12 text-center text-sm text-text-muted dark:border-white/10">
            <span className="material-symbols-outlined text-3xl opacity-40">query_stats</span>
            <p>No historical telemetry collected yet for this observation window.</p>
            <p className="text-xs text-text-muted/70">Metrics accumulate continuously as new completion attempts finalize.</p>
          </div>
        ) : (
          <div className="relative w-full overflow-hidden">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full h-auto overflow-visible select-none"
              style={{ minHeight: "180px" }}
            >
              {/* Horizontal Grid lines */}
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const y = paddingTop + chartHeight * (1 - ratio);
                const latVal = Math.round(maxLatency * ratio);
                return (
                  <g key={ratio}>
                    <line
                      x1={paddingLeft}
                      y1={y}
                      x2={width - paddingRight}
                      y2={y}
                      stroke="currentColor"
                      strokeOpacity={0.06}
                      strokeDasharray="3 3"
                    />
                    <text
                      x={width - paddingRight + 6}
                      y={y + 3}
                      fontSize="9"
                      fill="currentColor"
                      className="text-text-muted"
                      opacity={0.6}
                    >
                      {formatDuration(latVal)}
                    </text>
                  </g>
                );
              })}

              {/* Throughput Bars */}
              {points.map((p, i) => {
                const barW = Math.max(3, chartWidth / Math.max(points.length * 1.5, 20));
                const barH = getBarHeight(p.requests);
                const x = getX(i) - barW / 2;
                const y = paddingTop + chartHeight - barH;
                const isHovered = hoveredIndex === i;

                return (
                  <rect
                    key={`bar-${i}`}
                    x={x}
                    y={y}
                    width={barW}
                    height={barH}
                    rx="1.5"
                    className={`transition-colors ${
                      isHovered
                        ? "fill-primary"
                        : p.failed > 0
                          ? "fill-red-400/40"
                          : "fill-primary/25 hover:fill-primary/50"
                    }`}
                  />
                );
              })}

              {/* TTFT p95 Line (Amber) */}
              {p95Path && (
                <path
                  d={p95Path}
                  fill="none"
                  stroke="#f59e0b"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={0.9}
                />
              )}

              {/* TTFT p50 Line (Primary) */}
              {p50Path && (
                <path
                  d={p50Path}
                  fill="none"
                  stroke="var(--color-primary, #3b82f6)"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}

              {/* Interactive Data Point Markers */}
              {points.map((p, i) => {
                const cx = getX(i);
                const cy50 = getLatencyY(p.p50TtftMs);
                const cy95 = getLatencyY(p.p95TtftMs);
                const isHovered = hoveredIndex === i;

                return (
                  <g key={`pt-${i}`} onMouseEnter={() => setHoveredIndex(i)}>
                    {/* Hover guide line */}
                    {isHovered && (
                      <line
                        x1={cx}
                        y1={paddingTop}
                        x2={cx}
                        y2={paddingTop + chartHeight}
                        stroke="currentColor"
                        strokeOpacity={0.25}
                        strokeWidth="1"
                        strokeDasharray="2 2"
                      />
                    )}

                    {/* p50 marker */}
                    {p.requests > 0 && (
                      <circle
                        cx={cx}
                        cy={cy50}
                        r={isHovered ? 5 : 2.5}
                        fill="var(--color-primary, #3b82f6)"
                        stroke="white"
                        strokeWidth="1.5"
                        className="transition-all"
                      />
                    )}

                    {/* p95 marker */}
                    {p.requests > 0 && p.p95TtftMs !== p.p50TtftMs && (
                      <circle
                        cx={cx}
                        cy={cy95}
                        r={isHovered ? 4.5 : 2}
                        fill="#f59e0b"
                        stroke="white"
                        strokeWidth="1"
                        className="transition-all"
                      />
                    )}

                    {/* Transparent hover capture rect */}
                    <rect
                      x={cx - chartWidth / (numPoints * 2)}
                      y={paddingTop}
                      width={chartWidth / numPoints}
                      height={chartHeight}
                      fill="transparent"
                      className="cursor-pointer"
                      onMouseEnter={() => setHoveredIndex(i)}
                      onMouseLeave={() => setHoveredIndex(null)}
                    />
                  </g>
                );
              })}

              {/* X Axis Time Labels */}
              {points.map((p, i) => {
                // Show at most 6-8 labels evenly spaced
                const step = Math.max(1, Math.floor(points.length / 6));
                if (i % step !== 0 && i !== points.length - 1) return null;
                const x = getX(i);
                return (
                  <text
                    key={`time-${i}`}
                    x={x}
                    y={height - 10}
                    fontSize="9"
                    textAnchor="middle"
                    fill="currentColor"
                    className="text-text-muted"
                    opacity={0.7}
                  >
                    {formatTimeLabel(p.timestamp, range)}
                  </text>
                );
              })}
            </svg>
          </div>
        )}
      </div>
    </Card>
  );
}
