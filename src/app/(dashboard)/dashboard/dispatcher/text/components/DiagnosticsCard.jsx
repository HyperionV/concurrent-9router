"use client";

import { AlertTriangle, ShieldCheck, Route, CheckCircle2 } from "lucide-react";

export default function DiagnosticsCard({
  terminal = {},
  watchdog = {},
  paths = [],
}) {
  const byState = terminal.byState || {};
  const byTerminalReason = terminal.byTerminalReason || {};
  const byTimeoutKind = terminal.byTimeoutKind || {};

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {/* 1. Terminal Outcome Taxonomy */}
      <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2 border-b border-border/60 pb-2">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          <h4 className="text-xs font-semibold text-foreground">Outcome Taxonomy</h4>
        </div>
        <div className="mt-3 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Completed Normal</span>
            <span className="font-mono font-medium text-emerald-400">{byState.completed || 0}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Upstream Failures</span>
            <span className="font-mono font-medium text-red-400">{byState.failed || 0}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Timed Out</span>
            <span className="font-mono font-medium text-amber-400">{byState.timed_out || 0}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Client Cancelled</span>
            <span className="font-mono text-muted-foreground">{byState.cancelled || 0}</span>
          </div>
        </div>
      </div>

      {/* 2. Watchdog & Guardrails */}
      <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2 border-b border-border/60 pb-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h4 className="text-xs font-semibold text-foreground">Watchdog Interventions</h4>
        </div>
        <div className="mt-3 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Idle Stream Timeout</span>
            <span className="font-mono font-medium text-amber-400">
              {byTimeoutKind.idle_stream || 0}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Connect Timeout</span>
            <span className="font-mono font-medium text-amber-400">
              {byTimeoutKind.connect || 0}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Queue TTL Expiry</span>
            <span className="font-mono text-muted-foreground">
              {byTimeoutKind.queue_ttl || 0}
            </span>
          </div>
          <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-1 border-t border-border/30">
            <span>Watchdog Policy</span>
            <span className="font-mono text-emerald-400 font-medium">3m idle / 45s prefill</span>
          </div>
        </div>
      </div>

      {/* 3. Transport Path Routing */}
      <div className="rounded-xl border border-border/70 bg-card/60 p-4 shadow-sm backdrop-blur-sm">
        <div className="flex items-center gap-2 border-b border-border/60 pb-2">
          <Route className="h-4 w-4 text-primary" />
          <h4 className="text-xs font-semibold text-foreground">Transport Path Modes</h4>
        </div>
        <div className="mt-3 space-y-2 text-xs">
          {paths.length === 0 ? (
            <div className="py-3 text-center text-muted-foreground">
              Direct / standard execution
            </div>
          ) : (
            paths.map((p) => (
              <div key={p.pathMode} className="flex items-center justify-between">
                <span className="font-mono text-muted-foreground">{p.pathMode}</span>
                <div className="flex items-center gap-2 font-mono">
                  <span className="text-foreground font-medium">{p.total} total</span>
                  {p.active > 0 && (
                    <span className="text-blue-400">({p.active} active)</span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
