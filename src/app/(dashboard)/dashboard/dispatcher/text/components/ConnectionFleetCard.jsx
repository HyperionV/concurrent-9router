"use client";

import { useMemo, useState } from "react";
import {
  Server,
  Zap,
  Clock,
  Cpu,
  ArrowUpRight,
  ArrowDownRight,
  ChevronDown,
  ChevronUp,
  Layers,
} from "lucide-react";

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
  if (!Number.isFinite(value) || value <= 0) return "--";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return "Never active";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "Never active";
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 10) return "Active now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

function formatFullTimestamp(isoStr) {
  if (!isoStr) return "No recorded activity";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "Invalid date";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function ConnectionFleetCard({
  connections = [],
  range = "24h",
}) {
  const [expandedCards, setExpandedCards] = useState({});

  const toggleExpand = (cid) => {
    setExpandedCards((prev) => ({
      ...prev,
      [cid]: !prev[cid],
    }));
  };

  const sortedConnections = useMemo(() => {
    if (!Array.isArray(connections)) return [];
    return [...connections].sort((a, b) => {
      const occA = a.occupiedSlots ?? a.activeOccupancy ?? 0;
      const occB = b.occupiedSlots ?? b.activeOccupancy ?? 0;
      if (occB !== occA) return occB - occA;
      const totalA = a.totalRequests || a.recentAttempts || 0;
      const totalB = b.totalRequests || b.recentAttempts || 0;
      return totalB - totalA;
    });
  }, [connections]);

  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">
            Fleet Accounts & Capacity Balancing
          </h3>
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {sortedConnections.length} accounts
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          Historical window: {range}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sortedConnections.length === 0 ? (
          <div className="col-span-full py-8 text-center text-xs text-muted-foreground">
            No accounts configured or active in this pool
          </div>
        ) : (
          sortedConnections.map((conn, idx) => {
            const cid = conn.connectionId || conn.id || `conn-${idx}`;
            const cname = conn.connectionName || conn.name || cid;
            const occupancy = conn.occupiedSlots ?? conn.activeOccupancy ?? 0;
            const maxSlots = conn.capacity ?? conn.slots ?? 1;
            const occPct = Math.min(100, Math.round((occupancy / maxSlots) * 100));

            const lastActiveAt = conn.lastAttemptAt;
            const lastActiveRelative = formatRelativeTime(lastActiveAt);
            const lastActiveFull = formatFullTimestamp(lastActiveAt);
            const isLive = lastActiveRelative === "Active now" || occupancy > 0;

            const totalReqs = Number(conn.totalRequests) || Number(conn.recentAttempts) || 0;
            const windowReqs = Number(conn.recentAttempts) || 0;

            const promptTokens = Number(conn.promptTokens) || 0;
            const completionTokens = Number(conn.completionTokens) || 0;
            const totalTokens = Number(conn.totalTokens) || (promptTokens + completionTokens);

            const p95Ttft = conn.p95TtftMs;
            const avgTtft = conn.avgTtftMs;

            const models = Array.isArray(conn.tokensPerModel) ? conn.tokensPerModel : [];
            const isExpanded = !!expandedCards[cid];
            const visibleModels = isExpanded ? models : models.slice(0, 2);

            return (
              <div
                key={cid}
                className="relative flex flex-col justify-between rounded-lg border border-border/60 bg-background/50 p-3.5 shadow-sm hover:border-border/90 transition-all"
              >
                <div>
                  {/* Account Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            isLive
                              ? "bg-emerald-400 animate-pulse shadow-sm shadow-emerald-500/50"
                              : conn.enabled !== false
                                ? "bg-slate-400"
                                : "bg-red-400"
                          }`}
                        />
                        <span
                          className="truncate text-xs font-semibold text-foreground"
                          title={cname}
                        >
                          {cname}
                        </span>
                      </div>
                      <div
                        className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate"
                        title={cid}
                      >
                        {cid.length > 20 ? `${cid.substring(0, 20)}…` : cid}
                      </div>
                    </div>

                    {/* Last Used Badge */}
                    <div className="flex flex-col items-end shrink-0">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                          isLive
                            ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                            : lastActiveRelative !== "Never active"
                              ? "bg-muted text-foreground border border-border/40"
                              : "bg-muted/60 text-muted-foreground"
                        }`}
                        title={`Last active: ${lastActiveFull}`}
                      >
                        {lastActiveRelative}
                      </span>
                    </div>
                  </div>

                  {/* Slot Capacity Meter */}
                  <div className="mt-3 rounded-md bg-muted/30 p-2 border border-border/40">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground font-medium">Slot Occupancy</span>
                      <span className="font-mono font-medium text-foreground">
                        {occupancy} / {maxSlots}{" "}
                        <span className="text-muted-foreground text-[10px]">
                          ({occPct}%)
                        </span>
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full rounded-full bg-muted/80 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${
                          occPct >= 90
                            ? "bg-red-500"
                            : occPct >= 60
                              ? "bg-amber-500"
                              : "bg-primary"
                        }`}
                        style={{ width: `${occPct}%` }}
                      />
                    </div>
                  </div>

                  {/* Primary Metrics Grid: Total Reqs, P95 TTFT, Total Tokens */}
                  <div className="mt-3 grid grid-cols-3 gap-1.5 border-t border-border/40 pt-2.5 text-[10px]">
                    <div
                      className="rounded bg-muted/20 p-1.5 border border-border/30"
                      title={`${totalReqs.toLocaleString()} total requests across lifetime`}
                    >
                      <span className="text-muted-foreground block text-[9px] uppercase tracking-wider font-semibold">
                        Requests
                      </span>
                      <span className="font-mono font-bold text-foreground text-xs block mt-0.5">
                        {formatCompactNumber(totalReqs)}
                      </span>
                      <span className="text-[9px] text-muted-foreground block truncate">
                        {windowReqs > 0 ? `${formatCompactNumber(windowReqs)} in ${range}` : `0 in ${range}`}
                      </span>
                    </div>

                    <div
                      className="rounded bg-muted/20 p-1.5 border border-border/30"
                      title={p95Ttft > 0 ? `P95 TTFT: ${formatDuration(p95Ttft)}` : "No TTFT recorded"}
                    >
                      <span className="text-muted-foreground block text-[9px] uppercase tracking-wider font-semibold">
                        P95 TTFT
                      </span>
                      <span className="font-mono font-bold text-foreground text-xs block mt-0.5">
                        {formatDuration(p95Ttft)}
                      </span>
                      <span className="text-[9px] text-muted-foreground block truncate">
                        {avgTtft > 0 ? `Avg ${formatDuration(avgTtft)}` : "Latency"}
                      </span>
                    </div>

                    <div
                      className="rounded bg-muted/20 p-1.5 border border-border/30"
                      title={`${totalTokens.toLocaleString()} total tokens processed`}
                    >
                      <span className="text-muted-foreground block text-[9px] uppercase tracking-wider font-semibold">
                        Tokens
                      </span>
                      <span className="font-mono font-bold text-foreground text-xs block mt-0.5 text-primary">
                        {formatCompactNumber(totalTokens)}
                      </span>
                      <span className="text-[9px] text-muted-foreground block truncate">
                        Total Volume
                      </span>
                    </div>
                  </div>

                  {/* Input / Output Tokens Breakdown */}
                  <div className="mt-2 flex items-center justify-between gap-1 rounded bg-muted/20 px-2 py-1.5 border border-border/30 text-[10px]">
                    <div
                      className="flex items-center gap-1 min-w-0"
                      title={`Input (prompt): ${promptTokens.toLocaleString()} tokens`}
                    >
                      <ArrowUpRight className="h-3 w-3 text-sky-400 shrink-0" />
                      <span className="text-muted-foreground text-[9px]">In:</span>
                      <span className="font-mono font-medium text-foreground">
                        {formatCompactNumber(promptTokens)}
                      </span>
                    </div>

                    <div className="h-3 w-[1px] bg-border/60" />

                    <div
                      className="flex items-center gap-1 min-w-0"
                      title={`Output (completion): ${completionTokens.toLocaleString()} tokens`}
                    >
                      <ArrowDownRight className="h-3 w-3 text-emerald-400 shrink-0" />
                      <span className="text-muted-foreground text-[9px]">Out:</span>
                      <span className="font-mono font-medium text-foreground">
                        {formatCompactNumber(completionTokens)}
                      </span>
                    </div>
                  </div>

                  {/* Per-Model Token Breakdown */}
                  <div className="mt-2.5 border-t border-border/40 pt-2 text-[10px]">
                    <div className="flex items-center justify-between text-muted-foreground mb-1.5">
                      <div className="flex items-center gap-1 font-medium text-[10px]">
                        <Cpu className="h-3 w-3 text-muted-foreground/70" />
                        <span>Tokens per Model</span>
                        {models.length > 0 && (
                          <span className="rounded-full bg-muted px-1.5 py-0.2 text-[9px] text-foreground">
                            {models.length}
                          </span>
                        )}
                      </div>
                      {models.length > 2 && (
                        <button
                          type="button"
                          onClick={() => toggleExpand(cid)}
                          className="flex items-center gap-0.5 text-[10px] text-primary hover:underline"
                        >
                          <span>{isExpanded ? "Collapse" : `+${models.length - 2} more`}</span>
                          {isExpanded ? (
                            <ChevronUp className="h-2.5 w-2.5" />
                          ) : (
                            <ChevronDown className="h-2.5 w-2.5" />
                          )}
                        </button>
                      )}
                    </div>

                    {models.length === 0 ? (
                      <div className="py-1.5 text-center text-[10px] text-muted-foreground/60 italic">
                        No model traffic recorded
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1">
                        {visibleModels.map((m) => {
                          const mTotal = Number(m.totalTokens) || 0;
                          const mReqs = Number(m.requestCount) || 0;
                          const mPrompt = Number(m.promptTokens) || 0;
                          const mComp = Number(m.completionTokens) || 0;

                          return (
                            <div
                              key={m.modelId}
                              className="flex items-center justify-between gap-1.5 rounded px-1.5 py-1 bg-muted/15 hover:bg-muted/30 transition-colors"
                              title={`${m.modelId}: ${mTotal.toLocaleString()} tokens (${mReqs.toLocaleString()} reqs) | In: ${mPrompt.toLocaleString()} · Out: ${mComp.toLocaleString()}`}
                            >
                              <span className="truncate font-mono text-[10px] text-foreground font-medium max-w-[130px]">
                                {m.modelId}
                              </span>
                              <div className="flex items-center gap-1 shrink-0 font-mono text-[10px]">
                                <span className="font-semibold text-foreground">
                                  {formatCompactNumber(mTotal)}
                                </span>
                                <span className="text-[9px] text-muted-foreground">
                                  ({formatCompactNumber(mReqs)} reqs)
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
