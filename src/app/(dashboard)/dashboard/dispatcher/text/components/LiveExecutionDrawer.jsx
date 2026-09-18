"use client";

import { useState } from "react";
import { Activity, ListOrdered, History, ChevronDown, ChevronUp } from "lucide-react";

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "--";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return "--";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "--";
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  return `${Math.floor(diffSec / 60)}m ago`;
}

function formatShortId(id, len = 12) {
  if (!id || typeof id !== "string") return "--";
  return id.length > len ? `${id.substring(0, len)}…` : id;
}

export default function LiveExecutionDrawer({
  activeAttempts = [],
  queuedRequests = [],
  terminalAttempts = [],
}) {
  const [activeTab, setActiveTab] = useState("active"); // 'active' | 'queued' | 'terminal'
  const [isOpen, setIsOpen] = useState(true);

  return (
    <div className="rounded-xl border border-border/70 bg-card/60 shadow-sm backdrop-blur-sm">
      <div className="flex items-center justify-between p-4 border-b border-border/60">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Live Execution & Queue Registry</h3>
          <span className="rounded-md bg-blue-500/10 px-2 py-0.5 text-xs font-mono font-medium text-blue-400">
            {activeAttempts.length} active
          </span>
          {queuedRequests.length > 0 && (
            <span className="rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-mono font-medium text-amber-400">
              {queuedRequests.length} queued
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-lg bg-muted/60 p-0.5 text-xs">
            <button
              onClick={() => setActiveTab("active")}
              className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                activeTab === "active"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Active Leases ({activeAttempts.length})
            </button>
            <button
              onClick={() => setActiveTab("queued")}
              className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                activeTab === "queued"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Wait Queue ({queuedRequests.length})
            </button>
            <button
              onClick={() => setActiveTab("terminal")}
              className={`rounded-md px-2.5 py-1 font-medium transition-all ${
                activeTab === "terminal"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Recent Completed ({terminalAttempts.length})
            </button>
          </div>

          <button
            onClick={() => setIsOpen(!isOpen)}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {isOpen && (
        <div className="p-4 overflow-x-auto">
          {activeTab === "active" ? (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground">
                  <th className="pb-2 font-medium">Attempt ID</th>
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium">Connection</th>
                  <th className="pb-2 font-medium">State</th>
                  <th className="pb-2 font-medium">Path</th>
                  <th className="pb-2 font-medium text-right">Age</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {activeAttempts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-muted-foreground">
                      No active in-flight requests running
                    </td>
                  </tr>
                ) : (
                  activeAttempts.map((att, idx) => (
                    <tr key={att.id || `att-${idx}`} className="hover:bg-muted/30">
                      <td className="py-2 font-mono text-foreground font-medium">
                        {formatShortId(att.id)}
                      </td>
                      <td className="py-2 font-mono text-foreground">{att.modelId || "--"}</td>
                      <td className="py-2 font-mono text-muted-foreground">
                        {formatShortId(att.connectionId)}
                      </td>
                      <td className="py-2">
                        <span className="inline-flex items-center gap-1 rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
                          {att.state || "unknown"}
                        </span>
                      </td>
                      <td className="py-2 font-mono text-[11px] text-muted-foreground">
                        {att.pathMode || "direct"}
                      </td>
                      <td className="py-2 text-right font-mono text-muted-foreground">
                        {formatRelativeTime(att.queueEnteredAt || att.leasedAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : activeTab === "queued" ? (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground">
                  <th className="pb-2 font-medium">Request ID</th>
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium">Format</th>
                  <th className="pb-2 font-medium text-right">Queued At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {queuedRequests.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-muted-foreground">
                      Admission queue is empty (all requests dispatched immediately)
                    </td>
                  </tr>
                ) : (
                  queuedRequests.map((req, idx) => (
                    <tr key={req.id || `req-${idx}`} className="hover:bg-muted/30">
                      <td className="py-2 font-mono text-foreground font-medium">
                        {formatShortId(req.id)}
                      </td>
                      <td className="py-2 font-mono text-foreground">{req.modelId || "--"}</td>
                      <td className="py-2 font-mono text-[11px] text-muted-foreground">
                        {req.sourceFormat || "--"} → {req.targetFormat || "--"}
                      </td>
                      <td className="py-2 text-right font-mono text-amber-400">
                        {formatRelativeTime(req.queuedAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground">
                  <th className="pb-2 font-medium">Attempt ID</th>
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium">State</th>
                  <th className="pb-2 font-medium">Reason</th>
                  <th className="pb-2 font-medium text-right">Queue Wait</th>
                  <th className="pb-2 font-medium text-right">TTFT</th>
                  <th className="pb-2 font-medium text-right">Finished</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/30">
                {terminalAttempts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-muted-foreground">
                      No terminal attempts recorded
                    </td>
                  </tr>
                ) : (
                  terminalAttempts.slice(0, 20).map((att, idx) => (
                    <tr key={att.id || `term-${idx}`} className="hover:bg-muted/30">
                      <td className="py-2 font-mono text-foreground font-medium">
                        {formatShortId(att.id)}
                      </td>
                      <td className="py-2 font-mono text-foreground">{att.modelId || "--"}</td>
                      <td className="py-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            att.state === "completed"
                              ? "bg-emerald-500/10 text-emerald-400"
                              : "bg-red-500/10 text-red-400"
                          }`}
                        >
                          {att.state || "unknown"}
                        </span>
                      </td>
                      <td className="py-2 font-mono text-[11px] text-muted-foreground">
                        {att.terminalReason || "--"}
                      </td>
                      <td className="py-2 text-right font-mono text-muted-foreground">
                        {formatDuration(att.queueWaitMs)}
                      </td>
                      <td className="py-2 text-right font-mono text-cyan-400">
                        {formatDuration(att.ttftMs)}
                      </td>
                      <td className="py-2 text-right font-mono text-muted-foreground">
                        {formatRelativeTime(att.finishedAt)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
