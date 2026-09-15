"use client";

import { useEffect, useState } from "react";
import { Modal, Button, Badge } from "@/shared/components";
import { formatBytes } from "../utils";

export default function OptimizationModal({ isOpen, onClose, onComplete }) {
  const [estimates, setEstimates] = useState(null);
  const [loadingEstimates, setLoadingEstimates] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [auditResult, setAuditResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setAuditResult(null);
      setError(null);
      setLoadingEstimates(true);
      fetch("/api/system/optimize")
        .then((res) => res.json())
        .then((json) => {
          if (json.ok && json.data) setEstimates(json.data);
        })
        .catch(() => {})
        .finally(() => setLoadingEstimates(false));
    }
  }, [isOpen]);

  const handleRunOptimization = async () => {
    setOptimizing(true);
    setError(null);
    try {
      const res = await fetch("/api/system/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retentionDays: 7 }),
      });
      const json = await res.json();
      if (json.ok && json.audit) {
        setAuditResult(json.audit);
        if (onComplete) onComplete(json.audit);
      } else {
        setError(json.error || "Optimization failed");
      }
    } catch (err) {
      setError(err.message || "Failed to execute optimization");
    } finally {
      setOptimizing(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="System Resource Optimization"
      size="md"
    >
      <div className="space-y-4 text-xs">
        {!auditResult ? (
          <>
            <p className="text-text-muted leading-relaxed">
              Trigger a multi-stage cleanup to defragment SQLite storage, reset the Write-Ahead Log, prune expired telemetry, and compact memory.
            </p>

            {/* Stages overview */}
            <div className="space-y-2 rounded-lg border border-black/5 dark:border-white/5 bg-black/5 dark:bg-white/5 p-3">
              <div className="flex items-start gap-2.5">
                <span className="material-symbols-outlined text-[18px] text-primary mt-0.5">
                  database
                </span>
                <div>
                  <p className="font-semibold text-text-main">1. SQLite WAL Truncation & Optimization</p>
                  <p className="text-text-muted text-[11px]">
                    Flushes WAL frames to disk and resets the journal file to 0 bytes, optimizing index statistics.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2.5">
                <span className="material-symbols-outlined text-[18px] text-blue-500 mt-0.5">
                  delete_sweep
                </span>
                <div>
                  <p className="font-semibold text-text-main">2. Telemetry & Affinity Retention Prune</p>
                  <p className="text-text-muted text-[11px]">
                    Purges dispatch ledger records and conversation affinity mappings older than 7 days.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-2.5">
                <span className="material-symbols-outlined text-[18px] text-purple-500 mt-0.5">
                  memory
                </span>
                <div>
                  <p className="font-semibold text-text-main">3. V8 Memory Compaction</p>
                  <p className="text-text-muted text-[11px]">
                    Triggers V8 heap compaction to release physical Resident Set Size back to the host operating system.
                  </p>
                </div>
              </div>
            </div>

            {/* Estimated Reclaimable */}
            {estimates && (
              <div className="flex items-center justify-between rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                <div>
                  <span className="font-semibold text-emerald-600 dark:text-emerald-400 block">
                    Estimated Reclaimable Storage
                  </span>
                  <span className="text-[11px] text-text-muted">
                    WAL Journal + Freelist Space
                  </span>
                </div>
                <span className="text-base font-bold font-mono text-emerald-600 dark:text-emerald-400">
                  {formatBytes(estimates.estimatedReclaimableBytes)}
                </span>
              </div>
            )}

            {error && (
              <div className="p-3 rounded-lg bg-rose-500/10 text-rose-500 border border-rose-500/20">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-black/5 dark:border-white/5">
              <Button variant="outline" onClick={onClose} disabled={optimizing}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleRunOptimization}
                disabled={optimizing}
                className="flex items-center gap-1.5"
              >
                <span className={`material-symbols-outlined text-[16px] ${optimizing ? "animate-spin" : ""}`}>
                  {optimizing ? "sync" : "rocket_launch"}
                </span>
                <span>{optimizing ? "Optimizing..." : "Start Cleanup"}</span>
              </Button>
            </div>
          </>
        ) : (
          /* Audit Results Delta */
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-emerald-500">
                  check_circle
                </span>
                <span className="font-bold text-text-main text-sm">Optimization Completed</span>
              </div>
              <Badge variant="success">{auditResult.durationMs} ms</Badge>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
                <span className="text-[10px] text-text-muted uppercase block">WAL Reclaimed</span>
                <span className="text-sm font-bold text-emerald-500 font-mono">
                  {formatBytes(auditResult.database.walBytesReclaimed)}
                </span>
                <span className="text-[10px] text-text-muted block mt-0.5">
                  Mode: {auditResult.database.checkpointMode}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
                <span className="text-[10px] text-text-muted uppercase block">Heap / RAM Freed</span>
                <span className="text-sm font-bold text-purple-500 font-mono">
                  {formatBytes(auditResult.memory.heapBytesFreed || auditResult.memory.rssBytesFreed)}
                </span>
                <span className="text-[10px] text-text-muted block mt-0.5">
                  {auditResult.memory.gcExecuted ? "V8 GC Executed" : "Caches Cleared"}
                </span>
              </div>

              <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
                <span className="text-[10px] text-text-muted uppercase block">Records Pruned</span>
                <span className="text-sm font-bold text-text-main font-mono">
                  {auditResult.database.totalPruned}
                </span>
                <span className="text-[10px] text-text-muted block mt-0.5">
                  Expired attempts & affinities
                </span>
              </div>

              <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
                <span className="text-[10px] text-text-muted uppercase block">Query Planner</span>
                <span className="text-sm font-bold text-blue-500 font-mono">
                  {auditResult.database.optimized ? "Optimized" : "Skipped"}
                </span>
                <span className="text-[10px] text-text-muted block mt-0.5">
                  PRAGMA optimize
                </span>
              </div>
            </div>

            <div className="flex justify-end pt-2 border-t border-black/5 dark:border-white/5">
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
