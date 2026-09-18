"use client";

import { useMemo } from "react";
import { Cpu, Zap, Database, Clock } from "lucide-react";

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

export default function ModelPerformanceTable({ models = [], range = "24h" }) {
  const sortedModels = useMemo(() => {
    if (!Array.isArray(models)) return [];
    return [...models].sort((a, b) => (b.total || 0) - (a.total || 0));
  }, [models]);

  const maxRequests = useMemo(() => {
    let m = 1;
    for (const row of sortedModels) {
      if ((row.total || 0) > m) m = row.total || 0;
    }
    return m;
  }, [sortedModels]);

  return (
    <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
      <div className="flex items-center justify-between border-b border-border/60 pb-3">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Model Workload & Performance</h3>
          <span className="rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {sortedModels.length} models
          </span>
        </div>
        <span className="text-xs text-muted-foreground">Historical window: {range}</span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border/50 text-muted-foreground">
              <th className="pb-2 font-medium">Model ID</th>
              <th className="pb-2 font-medium text-right">Volume</th>
              <th className="pb-2 font-medium text-right">Prompt / Output</th>
              <th className="pb-2 font-medium text-right">Cache Hit %</th>
              <th className="pb-2 font-medium text-right">P50 TTFT</th>
              <th className="pb-2 font-medium text-right">P95 TTFT</th>
              <th className="pb-2 font-medium text-right">Queue Wait</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/30">
            {sortedModels.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-6 text-center text-muted-foreground">
                  No model activity recorded in this timeframe
                </td>
              </tr>
            ) : (
              sortedModels.map((m) => {
                const reqs = m.total || 0;
                const pctOfMax = Math.round((reqs / maxRequests) * 100);
                const cacheHit = m.cacheHitRate !== undefined
                  ? m.cacheHitRate
                  : ((m.cachedTokens || 0) + (m.promptTokens || 0) > 0
                      ? Number((((m.cachedTokens || 0) / ((m.promptTokens || 0) + (m.cachedTokens || 0))) * 100).toFixed(1))
                      : 0);

                return (
                  <tr key={m.modelId} className="hover:bg-muted/30 transition-colors">
                    <td className="py-2.5 pr-2">
                      <div className="font-mono font-medium text-foreground">{m.modelId}</div>
                      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        {m.active > 0 && (
                          <span className="flex items-center gap-1 text-blue-400 font-medium">
                            <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                            {m.active} active
                          </span>
                        )}
                        {m.failed > 0 && (
                          <span className="text-red-400">{m.failed} failed</span>
                        )}
                        {m.timedOut > 0 && (
                          <span className="text-amber-400">{m.timedOut} timeout</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 text-right font-mono pr-2">
                      <span className="font-medium text-foreground">{formatCompactNumber(reqs)}</span>
                      <div className="mt-1 h-1 w-20 ml-auto rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full bg-primary/70 rounded-full"
                          style={{ width: `${pctOfMax}%` }}
                        />
                      </div>
                    </td>
                    <td className="py-2.5 text-right font-mono pr-2 text-muted-foreground">
                      <span className="text-foreground">{formatCompactNumber(m.promptTokens || 0)}</span>
                      <span className="text-[10px] mx-1">/</span>
                      <span className="text-purple-400 font-medium">{formatCompactNumber(m.completionTokens || 0)}</span>
                    </td>
                    <td className="py-2.5 text-right font-mono pr-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
                          cacheHit > 30
                            ? "bg-emerald-500/10 text-emerald-400"
                            : cacheHit > 0
                              ? "bg-blue-500/10 text-blue-400"
                              : "text-muted-foreground"
                        }`}
                      >
                        {cacheHit}%
                      </span>
                    </td>
                    <td className="py-2.5 text-right font-mono pr-2 text-foreground">
                      {formatDuration(m.avgTtftMs)}
                    </td>
                    <td className="py-2.5 text-right font-mono pr-2 text-amber-400 font-medium">
                      {formatDuration(m.p95TtftMs)}
                    </td>
                    <td className="py-2.5 text-right font-mono text-muted-foreground">
                      {formatDuration(m.avgQueueWaitMs)}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
