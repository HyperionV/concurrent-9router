"use client";

import { useState } from "react";
import { Card, Badge } from "@/shared/components";
import { formatPercent } from "../utils";

function LiveAreaChart({
  title,
  subtitle,
  history = [],
  series = [],
  yFormatter = (v) => `${v}`,
  yMaxDefault = 100,
  unit = "%",
}) {
  const [hoverIndex, setHoverIndex] = useState(null);

  const width = 600;
  const height = 180;
  const padLeft = 40;
  const padRight = 15;
  const padTop = 15;
  const padBottom = 25;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const pointsCount = Math.max(2, history.length);

  // Determine dynamic maxY
  let maxY = yMaxDefault;
  for (const item of history) {
    for (const s of series) {
      const val = Number(item[s.key]) || 0;
      if (val > maxY) maxY = Math.ceil(val * 1.15);
    }
  }

  const getX = (index) => padLeft + (index / (pointsCount - 1)) * plotWidth;
  const getY = (val) => padTop + plotHeight - (Math.max(0, Math.min(maxY, val)) / maxY) * plotHeight;

  // Build SVG paths for each series
  const renderedSeries = series.map((s) => {
    if (history.length === 0) return { ...s, linePath: "", areaPath: "" };

    const coords = history.map((item, idx) => ({
      x: getX(idx),
      y: getY(Number(item[s.key]) || 0),
    }));

    const linePath = coords.reduce(
      (acc, pt, i) => `${acc} ${i === 0 ? "M" : "L"} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`,
      ""
    );

    const firstX = coords[0].x.toFixed(1);
    const lastX = coords[coords.length - 1].x.toFixed(1);
    const baseY = (padTop + plotHeight).toFixed(1);
    const areaPath = `${linePath} L ${lastX} ${baseY} L ${firstX} ${baseY} Z`;

    return { ...s, linePath, areaPath, coords };
  });

  const hoveredData = hoverIndex !== null && history[hoverIndex] ? history[hoverIndex] : null;

  return (
    <Card className="p-4 border-black/5 dark:border-white/5 bg-surface flex flex-col justify-between">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h4 className="text-sm font-semibold text-text-main">{title}</h4>
          <p className="text-xs text-text-muted">{subtitle}</p>
        </div>
        <div className="flex items-center gap-3 text-xs">
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: s.color }} />
              <span className="text-text-muted">{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="relative w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto overflow-visible select-none"
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.0} />
              </linearGradient>
            ))}
          </defs>

          {/* Grid lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = padTop + plotHeight * (1 - ratio);
            const val = Math.round(maxY * ratio);
            return (
              <g key={ratio}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="currentColor"
                  className="text-black/5 dark:text-white/5"
                  strokeDasharray="3 3"
                />
                <text
                  x={padLeft - 6}
                  y={y + 3}
                  textAnchor="end"
                  className="fill-text-muted text-[10px]"
                >
                  {yFormatter(val)}
                </text>
              </g>
            );
          })}

          {/* Render Area & Lines */}
          {renderedSeries.map((s) => (
            <g key={s.key}>
              <path d={s.areaPath} fill={`url(#grad-${s.key})`} />
              <path
                d={s.linePath}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          ))}

          {/* Hover interactive vertical line */}
          {hoverIndex !== null && history[hoverIndex] && (
            <g>
              <line
                x1={getX(hoverIndex)}
                y1={padTop}
                x2={getX(hoverIndex)}
                y2={padTop + plotHeight}
                stroke="currentColor"
                className="text-text-muted/40"
                strokeDasharray="2 2"
              />
              {renderedSeries.map((s) => {
                const pt = s.coords[hoverIndex];
                if (!pt) return null;
                return (
                  <circle
                    key={s.key}
                    cx={pt.x}
                    cy={pt.y}
                    r="4"
                    fill={s.color}
                    stroke="#fff"
                    strokeWidth="1.5"
                  />
                );
              })}
            </g>
          )}

          {/* Invisible interactive hover rects */}
          {history.map((_, idx) => (
            <rect
              key={idx}
              x={getX(idx) - plotWidth / (pointsCount * 2)}
              y={padTop}
              width={plotWidth / pointsCount}
              height={plotHeight}
              fill="transparent"
              className="cursor-crosshair"
              onMouseEnter={() => setHoverIndex(idx)}
            />
          ))}
        </svg>

        {/* Floating Tooltip */}
        {hoveredData && (
          <div className="absolute top-2 right-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface/90 backdrop-blur-md px-2.5 py-1.5 shadow-lg text-[11px] pointer-events-none flex items-center gap-3">
            <span className="text-text-muted font-mono">{hoveredData.timeLabel}</span>
            {series.map((s) => (
              <span key={s.key} className="font-semibold" style={{ color: s.color }}>
                {s.label}: {yFormatter(hoveredData[s.key])}
              </span>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

export default function SystemLiveCharts({ history = [] }) {
  if (!history || history.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* 1. CPU History */}
      <LiveAreaChart
        title="Realtime CPU Utilization"
        subtitle="Host aggregate vs Node.js process"
        history={history}
        unit="%"
        yMaxDefault={100}
        yFormatter={(v) => `${Math.round(v)}%`}
        series={[
          { key: "hostCpu", label: "Host CPU", color: "#f97815" },
          { key: "processCpu", label: "Node Process", color: "#3b82f6" },
        ]}
      />

      {/* 2. Memory History */}
      <LiveAreaChart
        title="Application Memory"
        subtitle="RSS physical RAM vs V8 Heap used"
        history={history}
        unit="MB"
        yMaxDefault={200}
        yFormatter={(v) => `${Math.round(v)} MB`}
        series={[
          { key: "rssMb", label: "Process RSS", color: "#a855f7" },
          { key: "heapUsedMb", label: "V8 Heap Used", color: "#10b981" },
        ]}
      />

      {/* 3. Event Loop Latency */}
      <LiveAreaChart
        title="Event Loop Latency"
        subtitle="Mean vs p99 delay"
        history={history}
        unit="ms"
        yMaxDefault={20}
        yFormatter={(v) => `${v}ms`}
        series={[
          { key: "eventLoopMean", label: "Mean Lag", color: "#10b981" },
          { key: "eventLoopP99", label: "p99 Tail", color: "#ef4444" },
        ]}
      />
    </div>
  );
}
