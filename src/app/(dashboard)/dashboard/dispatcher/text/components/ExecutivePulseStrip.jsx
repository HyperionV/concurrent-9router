"use client";

import { useMemo } from "react";
import { Zap, Clock, Database, ShieldCheck, Activity, Cpu } from "lucide-react";

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

export default function ExecutivePulseStrip({
  aggregates = {},
  capacity = {},
  activeCount = 0,
  queuedCount = 0,
  range = "24h",
}) {
  const totalRequests = aggregates.totalRequests || 0;
  const totalCompleted = aggregates.totalCompleted || 0;
  const totalFailed = aggregates.totalFailed || 0;
  const totalTimedOut = aggregates.totalTimedOut || 0;
  const successRate = totalRequests > 0
    ? Math.round((Math.max(0, totalRequests - totalFailed - totalTimedOut) / totalRequests) * 100)
    : 100;

  const totalTokens = aggregates.totalTokens || (aggregates.promptTokens || 0) + (aggregates.completionTokens || 0);
  const promptTokens = aggregates.promptTokens || 0;
  const completionTokens = aggregates.completionTokens || 0;
  const cachedTokens = aggregates.cachedTokens || 0;
  const cacheHitRate = aggregates.cacheHitRate !== undefined
    ? aggregates.cacheHitRate
    : (cachedTokens + promptTokens > 0 ? Number(((cachedTokens / (promptTokens + cachedTokens)) * 100).toFixed(1)) : 0);

  const p50Ttft = aggregates.p50TtftMs || aggregates.avgTtftMs || 0;
  const p95Ttft = aggregates.p95TtftMs || 0;
  const avgQueueWait = aggregates.avgQueueWaitMs || 0;

  const totalCapacity = capacity.totalCapacity || 0;
  const activeLeases = activeCount || capacity.activeLeases || 0;
  const saturationPct = totalCapacity > 0
    ? Math.round((activeLeases / totalCapacity) * 100)
    : 0;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {/* 1. Throughput & Generation Velocity */}
      <div className="relative overflow-hidden rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Throughput & Velocity
          </span>
          <div className="rounded-md bg-blue-500/10 p-1.5 text-blue-500">
            <Zap className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-2xl font-bold tracking-tight text-foreground">
            {formatCompactNumber(totalRequests)}
          </span>
          <span className="text-xs text-muted-foreground">reqs in {range}</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Completed Rate</span>
          <span className="font-mono font-medium text-emerald-500">
            {successRate}% success
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>In-Flight / Queued</span>
          <span className="font-mono text-foreground font-medium">
            {activeLeases} active / {queuedCount} queued
          </span>
        </div>
      </div>

      {/* 2. End-to-End Latency Experience */}
      <div className="relative overflow-hidden rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Prefill & Queue Latency
          </span>
          <div className="rounded-md bg-cyan-500/10 p-1.5 text-cyan-500">
            <Clock className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-2xl font-bold tracking-tight text-foreground">
            {formatDuration(p50Ttft)}
          </span>
          <span className="text-xs text-muted-foreground">P50 TTFT</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">P95 Tail TTFT</span>
          <span className="font-mono font-medium text-amber-500">
            {formatDuration(p95Ttft)}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>Queue Dwell Time</span>
          <span className="font-mono text-foreground font-medium">
            {formatDuration(avgQueueWait)}
          </span>
        </div>
      </div>

      {/* 3. Token Economics & Prompt Cache */}
      <div className="relative overflow-hidden rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Token & Cache Economics
          </span>
          <div className="rounded-md bg-emerald-500/10 p-1.5 text-emerald-500">
            <Database className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-2xl font-bold tracking-tight text-foreground">
            {formatCompactNumber(totalTokens)}
          </span>
          <span className="text-xs text-muted-foreground">total tokens</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Prompt Cache Hit</span>
          <span className="font-mono font-medium text-emerald-400">
            {cacheHitRate}% ({formatCompactNumber(cachedTokens)} saved)
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>In / Out Split</span>
          <span className="font-mono text-foreground font-medium">
            {formatCompactNumber(promptTokens)} / {formatCompactNumber(completionTokens)}
          </span>
        </div>
      </div>

      {/* 4. Pool Saturation & Fleet Reliability */}
      <div className="relative overflow-hidden rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Pool Saturation & Headroom
          </span>
          <div className="rounded-md bg-purple-500/10 p-1.5 text-purple-500">
            <ShieldCheck className="h-4 w-4" />
          </div>
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="text-2xl font-bold tracking-tight text-foreground">
            {saturationPct}%
          </span>
          <span className="text-xs text-muted-foreground">
            ({activeLeases} / {totalCapacity || 0} slots)
          </span>
        </div>
        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Active Accounts</span>
          <span className="font-mono font-medium text-foreground">
            {capacity.activeConnections || 0} accounts online
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>Available Headroom</span>
          <span className="font-mono text-emerald-400 font-medium">
            {capacity.availableLeases || 0} slots free
          </span>
        </div>
      </div>
    </div>
  );
}
