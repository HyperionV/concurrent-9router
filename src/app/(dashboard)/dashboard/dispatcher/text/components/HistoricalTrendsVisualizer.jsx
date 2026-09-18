"use client";

import { useState, useEffect, useMemo } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  ComposedChart,
} from "recharts";
import { Zap, Clock, Database, TrendingUp } from "lucide-react";

function formatCompactNumber(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "0 ms";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function formatTimeAxis(isoStr, range) {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "";
  if (range === "1h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (range === "7d") {
    return `${d.toLocaleDateString([], { month: "numeric", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function CustomTooltip({ active, payload, label, range }) {
  if (!active || !payload || !payload.length) return null;
  const d = new Date(label);
  const formattedTime = !Number.isNaN(d.getTime())
    ? d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : label;

  return (
    <div className="rounded-lg border border-border/80 bg-background/95 p-3 shadow-xl backdrop-blur-md">
      <div className="mb-2 border-b border-border/60 pb-1 text-xs font-semibold text-foreground">
        {formattedTime}
      </div>
      <div className="space-y-1 text-xs">
        {payload.map((entry, idx) => {
          let valDisplay = entry.value;
          if (entry.name.toLowerCase().includes("ms") || entry.name.toLowerCase().includes("wait") || entry.name.toLowerCase().includes("prefill") || entry.name.toLowerCase().includes("decode")) {
            valDisplay = formatDuration(entry.value);
          } else if (entry.name.toLowerCase().includes("rate") || entry.name.toLowerCase().includes("%")) {
            valDisplay = `${entry.value}%`;
          } else if (entry.name.toLowerCase().includes("tokens") || entry.name.toLowerCase().includes("requests")) {
            valDisplay = formatCompactNumber(entry.value);
          } else if (entry.name.toLowerCase().includes("velocity") || entry.name.toLowerCase().includes("tps")) {
            valDisplay = `${entry.value} tps`;
          }
          return (
            <div key={`tip-${idx}`} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5" style={{ color: entry.color }}>
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
                {entry.name}:
              </span>
              <span className="font-mono font-medium text-foreground">{valDisplay}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function HistoricalTrendsVisualizer({
  timeline = [],
  range = "24h",
  onRangeChange,
}) {
  const [activeTab, setActiveTab] = useState("velocity"); // 'velocity' | 'latency' | 'tokens'
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const chartData = useMemo(() => {
    return Array.isArray(timeline) ? timeline : [];
  }, [timeline]);

  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
      {/* Visualizer Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Historical Performance Trends</h3>
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {chartData.length} intervals ({range})
          </span>
        </div>

        {/* Narrative Tab Switcher & Range Buttons */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-muted/60 p-0.5 text-xs font-medium">
            <button
              onClick={() => setActiveTab("velocity")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-all ${
                activeTab === "velocity"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Zap className="h-3.5 w-3.5 text-blue-500" />
              <span>Throughput & Velocity</span>
            </button>
            <button
              onClick={() => setActiveTab("latency")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-all ${
                activeTab === "latency"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Clock className="h-3.5 w-3.5 text-cyan-500" />
              <span>3-Phase Latency</span>
            </button>
            <button
              onClick={() => setActiveTab("tokens")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 transition-all ${
                activeTab === "tokens"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Database className="h-3.5 w-3.5 text-emerald-500" />
              <span>Token Economics</span>
            </button>
          </div>

          {/* Timeframe selector */}
          <div className="flex rounded-lg bg-muted/60 p-0.5 text-xs">
            {["1h", "24h", "7d"].map((r) => (
              <button
                key={r}
                onClick={() => onRangeChange?.(r)}
                className={`rounded-md px-2 py-1 font-medium transition-all ${
                  range === r
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart Canvas */}
      <div className="mt-4 h-[260px] w-full min-w-0">
        {!mounted ? (
          <div className="h-full w-full rounded-lg bg-muted/10 animate-pulse flex items-center justify-center text-xs text-muted-foreground">
            Loading chart canvas…
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No historical data recorded in this timeframe
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={240}>
            {activeTab === "velocity" ? (
              <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="reqGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(t) => formatTimeAxis(t, range)}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="left"
                  tickFormatter={formatCompactNumber}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tickFormatter={(v) => `${v} tps`}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<CustomTooltip range={range} />} />
                <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
                <Area
                  yAxisId="left"
                  type="monotone"
                  dataKey="requests"
                  name="Request Volume"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  fill="url(#reqGrad)"
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="tps"
                  name="Generation Velocity (TPS)"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            ) : activeTab === "latency" ? (
              <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="queueGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#f59e0b" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="ttftGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#06b6d4" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#06b6d4" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="decodeGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(t) => formatTimeAxis(t, range)}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  tickLine={false}
                />
                <YAxis
                  tickFormatter={formatDuration}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<CustomTooltip range={range} />} />
                <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
                <Area
                  type="monotone"
                  dataKey="avgQueueWaitMs"
                  stackId="1"
                  name="Queue Dwell Wait"
                  stroke="#f59e0b"
                  fill="url(#queueGrad)"
                />
                <Area
                  type="monotone"
                  dataKey="avgTtftMs"
                  stackId="1"
                  name="Prefill / TTFT"
                  stroke="#06b6d4"
                  fill="url(#ttftGrad)"
                />
                <Area
                  type="monotone"
                  dataKey="decodeDurationMs"
                  stackId="1"
                  name="Stream Decode Duration"
                  stroke="#8b5cf6"
                  fill="url(#decodeGrad)"
                />
              </AreaChart>
            ) : (
              <ComposedChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                <defs>
                  <linearGradient id="cachedGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="promptGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.05} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(t) => formatTimeAxis(t, range)}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={{ stroke: "hsl(var(--border))" }}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="tokens"
                  tickFormatter={formatCompactNumber}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="pct"
                  orientation="right"
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<CustomTooltip range={range} />} />
                <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }} />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="cachedTokens"
                  stackId="tok"
                  name="Cached Tokens (Saved)"
                  stroke="#10b981"
                  fill="url(#cachedGrad)"
                />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="promptTokens"
                  stackId="tok"
                  name="Prompt Tokens"
                  stroke="#3b82f6"
                  fill="url(#promptGrad)"
                />
                <Area
                  yAxisId="tokens"
                  type="monotone"
                  dataKey="completionTokens"
                  stackId="tok"
                  name="Completion Tokens"
                  stroke="#a855f7"
                  fill="#a855f7"
                  fillOpacity={0.2}
                />
                <Line
                  yAxisId="pct"
                  type="monotone"
                  dataKey="cacheHitRate"
                  name="Prompt Cache Hit %"
                  stroke="#34d399"
                  strokeWidth={2}
                  dot={false}
                />
              </ComposedChart>
            )}
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
