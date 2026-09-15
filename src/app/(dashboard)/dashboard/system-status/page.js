"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, CardSkeleton, SegmentedControl } from "@/shared/components";
import SystemMetricCards from "./components/SystemMetricCards";
import SystemLiveCharts from "./components/SystemLiveCharts";
import ProcessDetailsCard from "./components/ProcessDetailsCard";
import ServerDetailsCard from "./components/ServerDetailsCard";
import StorageUsageCard from "./components/StorageUsageCard";

const MAX_HISTORY_POINTS = 35;

export default function SystemStatusPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(2000); // 2 seconds default
  const [activeTab, setActiveTab] = useState("all");
  const [history, setHistory] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);

  const fetchStatus = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const res = await fetch("/api/system/status", { cache: "no-store" });
      const json = await res.json();
      if (json.ok && json.data) {
        const payload = json.data;
        setData(payload);
        setLastUpdated(new Date());

        // Append to rolling history
        const now = new Date();
        const timeLabel = now.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });

        const newPoint = {
          timeLabel,
          timestamp: now.getTime(),
          hostCpu: payload.host?.cpu?.usagePercent ?? 0,
          processCpu: payload.application?.cpu?.usagePercent ?? 0,
          rssMb: Math.round(((payload.application?.memory?.rssBytes ?? 0) / 1048576) * 10) / 10,
          heapUsedMb: Math.round(((payload.application?.memory?.heapUsedBytes ?? 0) / 1048576) * 10) / 10,
          eventLoopMean: payload.application?.eventLoop?.meanMs ?? 0,
          eventLoopP99: payload.application?.eventLoop?.p99Ms ?? 0,
        };

        setHistory((prev) => {
          const next = [...prev, newPoint];
          return next.length > MAX_HISTORY_POINTS ? next.slice(-MAX_HISTORY_POINTS) : next;
        });
      }
    } catch (err) {
      console.error("Failed to fetch system telemetry:", err);
    } finally {
      setLoading(false);
      if (isManual) setRefreshing(false);
    }
  }, []);

  // Polling effect
  useEffect(() => {
    fetchStatus();

    if (refreshInterval <= 0) return;

    const timer = setInterval(() => {
      fetchStatus();
    }, refreshInterval);

    return () => clearInterval(timer);
  }, [fetchStatus, refreshInterval]);

  const tabOptions = [
    { value: "all", label: "Full View" },
    { value: "charts", label: "Realtime Charts" },
    { value: "storage", label: "Disks & Storage" },
    { value: "host", label: "Host & Hardware" },
    { value: "process", label: "Process & V8 Engine" },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header & Live Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight text-text-main">
              System Status
            </h1>
            {refreshInterval > 0 ? (
              <Badge variant="success" className="flex items-center gap-1.5 px-2 py-0.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>LIVE ({refreshInterval / 1000}s)</span>
              </Badge>
            ) : (
              <Badge variant="default" className="flex items-center gap-1.5 px-2 py-0.5">
                <span className="w-2 h-2 rounded-full bg-text-muted" />
                <span>PAUSED</span>
              </Badge>
            )}
          </div>
          <p className="text-xs text-text-muted mt-1">
            Realtime server performance, disk storage, Node.js resource accounting, and V8 telemetry
            {lastUpdated && ` • Updated ${lastUpdated.toLocaleTimeString()}`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Interval Selector */}
          <div className="flex items-center rounded-lg border border-black/10 dark:border-white/10 bg-surface p-0.5 text-xs">
            {[
              { label: "1s", val: 1000 },
              { label: "2s", val: 2000 },
              { label: "5s", val: 5000 },
              { label: "Pause", val: 0 },
            ].map((opt) => (
              <button
                key={opt.val}
                type="button"
                onClick={() => setRefreshInterval(opt.val)}
                className={`px-2.5 py-1 rounded-md font-medium transition-all ${
                  refreshInterval === opt.val
                    ? "bg-primary text-white shadow-xs"
                    : "text-text-muted hover:text-text-main"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Manual Refresh button */}
          <Button
            size="sm"
            variant="outline"
            onClick={() => fetchStatus(true)}
            disabled={refreshing}
            className="flex items-center gap-1.5"
          >
            <span
              className={`material-symbols-outlined text-[16px] ${
                refreshing ? "animate-spin" : ""
              }`}
            >
              refresh
            </span>
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {loading && !data ? (
        <CardSkeleton />
      ) : (
        <>
          {/* Primary Metric KPI Cards */}
          <SystemMetricCards data={data} />

          {/* View Tab Selector */}
          <div className="flex items-center justify-between">
            <SegmentedControl
              options={tabOptions}
              value={activeTab}
              onChange={setActiveTab}
            />
          </div>

          {/* Live Charts Section */}
          {(activeTab === "all" || activeTab === "charts") && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted">
                  Realtime Telemetry Timeline ({history.length} samples)
                </h3>
              </div>
              <SystemLiveCharts history={history} />
            </div>
          )}

          {/* Storage & Disks Section */}
          {(activeTab === "all" || activeTab === "storage") && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted">
                  Server Storage & Application Footprint
                </h3>
              </div>
              <StorageUsageCard data={data} />
            </div>
          )}

          {/* Host & Cores Section */}
          {(activeTab === "all" || activeTab === "host") && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted">
                  Host Infrastructure & Cores
                </h3>
              </div>
              <ServerDetailsCard data={data} />
            </div>
          )}

          {/* Process & V8 Diagnostics Section */}
          {(activeTab === "all" || activeTab === "process") && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-text-muted">
                  Node.js Application Runtime & V8 Internals
                </h3>
              </div>
              <ProcessDetailsCard data={data} onTriggerGc={() => fetchStatus(true)} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
