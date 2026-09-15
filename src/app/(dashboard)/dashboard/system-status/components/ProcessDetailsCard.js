"use client";

import { useState } from "react";
import { Card, Badge, Button } from "@/shared/components";
import { formatBytes, formatDuration, formatPercent } from "../utils";

export default function ProcessDetailsCard({ data, onTriggerGc }) {
  const [gcLoading, setGcLoading] = useState(false);
  const [gcResult, setGcResult] = useState(null);

  if (!data?.application) return null;

  const { application } = data;
  const { v8Heap, eventLoop, resourceUsage } = application;

  const handleGc = async () => {
    setGcLoading(true);
    setGcResult(null);
    try {
      const res = await fetch("/api/system/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "gc" }),
      });
      const json = await res.json();
      if (json.ok) {
        setGcResult(`Freed ${formatBytes(json.freedBytes)}`);
        if (onTriggerGc) onTriggerGc();
      } else {
        setGcResult(json.message || "GC not available");
      }
    } catch (e) {
      setGcResult("Failed to invoke GC");
    } finally {
      setGcLoading(false);
      setTimeout(() => setGcResult(null), 4000);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* V8 Engine Heap Architecture */}
      <Card className="p-5 border-black/5 dark:border-white/5 bg-surface space-y-4">
        <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-purple-500">
              account_tree
            </span>
            <h4 className="text-sm font-semibold text-text-main">V8 Engine & Heap Memory</h4>
          </div>
          <div className="flex items-center gap-2">
            {gcResult && (
              <span className="text-xs text-primary font-medium animate-fade-in">
                {gcResult}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={handleGc}
              disabled={gcLoading}
              className="text-xs"
            >
              <span className="material-symbols-outlined text-[14px]">delete_sweep</span>
              {gcLoading ? "Running..." : "Run GC"}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
            <p className="text-[11px] text-text-muted">Heap Used</p>
            <p className="text-sm font-semibold text-text-main mt-0.5">
              {formatBytes(application.memory.heapUsedBytes)}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
            <p className="text-[11px] text-text-muted">Heap Allocated</p>
            <p className="text-sm font-semibold text-text-main mt-0.5">
              {formatBytes(application.memory.heapTotalBytes)}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
            <p className="text-[11px] text-text-muted">Heap Limit</p>
            <p className="text-sm font-semibold text-text-main mt-0.5">
              {formatBytes(application.memory.heapLimitBytes)}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
            <p className="text-[11px] text-text-muted">Available Headroom</p>
            <p className="text-sm font-semibold text-emerald-500 mt-0.5">
              {formatBytes(application.memory.heapAvailableBytes)}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
            <p className="text-[11px] text-text-muted">External C++ Memory</p>
            <p className="text-sm font-semibold text-text-main mt-0.5">
              {formatBytes(application.memory.externalBytes)}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
            <p className="text-[11px] text-text-muted">ArrayBuffers</p>
            <p className="text-sm font-semibold text-text-main mt-0.5">
              {formatBytes(application.memory.arrayBuffersBytes)}
            </p>
          </div>
        </div>

        {v8Heap && (
          <div className="pt-2 border-t border-black/5 dark:border-white/5 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div>
              <span className="text-text-muted">Physical:</span>{" "}
              <span className="font-mono text-text-main">{formatBytes(v8Heap.totalPhysicalSize)}</span>
            </div>
            <div>
              <span className="text-text-muted">Malloced:</span>{" "}
              <span className="font-mono text-text-main">{formatBytes(v8Heap.mallocedMemory)}</span>
            </div>
            <div>
              <span className="text-text-muted">Peak Malloc:</span>{" "}
              <span className="font-mono text-text-main">{formatBytes(v8Heap.peakMallocedMemory)}</span>
            </div>
            <div>
              <span className="text-text-muted">Native Contexts:</span>{" "}
              <span className="font-mono text-text-main">{v8Heap.nativeContexts}</span>
            </div>
          </div>
        )}
      </Card>

      {/* Process Diagnostics & Runtime */}
      <Card className="p-5 border-black/5 dark:border-white/5 bg-surface space-y-4">
        <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-blue-500">
              terminal
            </span>
            <h4 className="text-sm font-semibold text-text-main">Process Diagnostics & Event Loop</h4>
          </div>
          <Badge variant="outline">PID: {application.pid}</Badge>
        </div>

        {/* Event loop percentiles */}
        {eventLoop && (
          <div>
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
              Event Loop Lag Distribution
            </p>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
              {[
                { label: "p50", val: eventLoop.p50Ms },
                { label: "p90", val: eventLoop.p90Ms },
                { label: "p95", val: eventLoop.p95Ms },
                { label: "p99", val: eventLoop.p99Ms },
                { label: "Max", val: eventLoop.maxMs },
                { label: "Min", val: eventLoop.minMs },
              ].map((item) => (
                <div key={item.label} className="p-2 rounded bg-black/5 dark:bg-white/5">
                  <span className="text-[10px] text-text-muted uppercase block">{item.label}</span>
                  <span className="text-xs font-bold text-text-main font-mono">{item.val} ms</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Process runtime metadata */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
          <div>
            <span className="text-text-muted block">Process Uptime</span>
            <span className="font-semibold text-text-main">
              {formatDuration(application.uptimeSeconds)}
            </span>
          </div>
          <div>
            <span className="text-text-muted block">Node.js Engine</span>
            <span className="font-mono text-text-main">{application.nodeVersion}</span>
          </div>
          <div>
            <span className="text-text-muted block">V8 Version</span>
            <span className="font-mono text-text-main">{application.versions?.v8 || "--"}</span>
          </div>
          <div>
            <span className="text-text-muted block">Libuv Version</span>
            <span className="font-mono text-text-main">{application.versions?.uv || "--"}</span>
          </div>
          <div>
            <span className="text-text-muted block">OpenSSL Version</span>
            <span className="font-mono text-text-main">{application.versions?.openssl || "--"}</span>
          </div>
          <div>
            <span className="text-text-muted block">Active I/O Handles</span>
            <span className="font-semibold text-text-main">
              {application.handlesAndRequests?.activeHandles ?? 0}
            </span>
          </div>
        </div>

        {/* OS Resource Usage */}
        {resourceUsage && (
          <div className="pt-2 border-t border-black/5 dark:border-white/5">
            <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-1.5">
              Kernel Resource Accounting
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <div>
                <span className="text-text-muted">FS Reads:</span>{" "}
                <span className="font-mono text-text-main">{resourceUsage.fsRead ?? 0}</span>
              </div>
              <div>
                <span className="text-text-muted">FS Writes:</span>{" "}
                <span className="font-mono text-text-main">{resourceUsage.fsWrite ?? 0}</span>
              </div>
              <div>
                <span className="text-text-muted">Page Faults:</span>{" "}
                <span className="font-mono text-text-main">
                  {(resourceUsage.majorPageFault ?? 0) + (resourceUsage.minorPageFault ?? 0)}
                </span>
              </div>
              <div>
                <span className="text-text-muted">Max RSS:</span>{" "}
                <span className="font-mono text-text-main">
                  {formatBytes((resourceUsage.maxRSS ?? 0) * 1024)}
                </span>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
