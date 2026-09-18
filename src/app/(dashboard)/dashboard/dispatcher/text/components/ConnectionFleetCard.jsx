"use client";

import { useMemo } from "react";
import { Server, Zap, CheckCircle2, AlertCircle, Clock } from "lucide-react";

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

export default function ConnectionFleetCard({
  connections = [],
  range = "24h",
}) {
  const sortedConnections = useMemo(() => {
    if (!Array.isArray(connections)) return [];
    return [...connections].sort((a, b) => {
      const occA = a.occupiedSlots ?? a.activeOccupancy ?? 0;
      const occB = b.occupiedSlots ?? b.activeOccupancy ?? 0;
      if (occB !== occA) return occB - occA;
      return (b.recentAttempts || 0) - (a.recentAttempts || 0);
    });
  }, [connections]);

  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Fleet Accounts & Capacity Balancing</h3>
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {sortedConnections.length} accounts
          </span>
        </div>
        <span className="text-xs text-muted-foreground">Historical window: {range}</span>
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
            const lastActive = formatRelativeTime(conn.lastAttemptAt);
            const isLive = lastActive === "Active now" || occupancy > 0;
            const reqs = conn.recentAttempts || 0;
            const cacheHit = conn.cacheHitRate || 0;

            return (
              <div
                key={cid}
                className="relative rounded-lg border border-border/60 bg-background/50 p-3 shadow-sm hover:border-border/90 transition-all"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`h-2 w-2 rounded-full ${
                          isLive
                            ? "bg-emerald-400 animate-pulse"
                            : conn.enabled !== false
                              ? "bg-slate-400"
                              : "bg-red-400"
                        }`}
                      />
                      <span className="truncate text-xs font-semibold text-foreground" title={cname}>
                        {cname}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate">
                      {cid.length > 16 ? `${cid.substring(0, 16)}…` : cid}
                    </div>
                  </div>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                      isLive
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {lastActive}
                  </span>
                </div>

                {/* Slot Capacity Meter */}
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Slot Occupancy</span>
                    <span className="font-mono font-medium text-foreground">
                      {occupancy} / {maxSlots} ({occPct}%)
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${
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

                {/* Performance & Token Telemetry */}
                <div className="mt-3 grid grid-cols-3 gap-1 border-t border-border/40 pt-2 text-[10px]">
                  <div>
                    <span className="text-muted-foreground block">Reqs</span>
                    <span className="font-mono font-medium text-foreground">
                      {formatCompactNumber(reqs)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground block">P95 TTFT</span>
                    <span className="font-mono font-medium text-foreground">
                      {formatDuration(conn.p95TtftMs)}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-muted-foreground block">Cache %</span>
                    <span className="font-mono font-medium text-emerald-400">
                      {cacheHit > 0 ? `${cacheHit}%` : "--"}
                    </span>
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
