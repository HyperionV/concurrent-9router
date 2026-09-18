"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardSkeleton, Spinner } from "@/shared/components";
import { AI_PROVIDERS } from "@/shared/constants/providers";

import ExecutivePulseStrip from "./components/ExecutivePulseStrip";
import HistoricalTrendsVisualizer from "./components/HistoricalTrendsVisualizer";
import ModelPerformanceTable from "./components/ModelPerformanceTable";
import ConnectionFleetCard from "./components/ConnectionFleetCard";
import DiagnosticsCard from "./components/DiagnosticsCard";
import LiveExecutionDrawer from "./components/LiveExecutionDrawer";
import DispatcherControlsCard from "./components/DispatcherControlsCard";

const LIVE_REFRESH_INTERVAL_MS = 3000;
const HISTORY_REFRESH_INTERVAL_MS = 20000;

function DispatcherSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <CardSkeleton />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
      <CardSkeleton />
      <CardSkeleton />
    </div>
  );
}

export default function DispatcherPage() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [statusProvider, setStatusProvider] = useState("codex");
  const [configuredProviders, setConfiguredProviders] = useState([]);
  const [timeRange, setTimeRange] = useState("24h");

  // Fetch all registered providers with active connections to build dynamic switcher tabs
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/providers", { cache: "no-store" }),
      fetch("/api/provider-nodes", { cache: "no-store" }),
    ])
      .then(async ([provRes, nodesRes]) => {
        const provData = provRes.ok ? await provRes.json() : {};
        const nodesData = nodesRes.ok ? await nodesRes.json() : {};
        if (cancelled) return;

        const connectionProviders = new Set(
          (provData.connections || []).map((c) => c.provider),
        );
        const nodeIds = (nodesData.nodes || []).map((n) => n.id);

        const allIds = new Set([
          "codex",
          "antigravity",
          "grok-cli",
          "openai",
          "anthropic",
          "gemini",
          ...connectionProviders,
          ...nodeIds,
        ]);

        const providerOptions = Array.from(allIds).map((id) => {
          const known = AI_PROVIDERS[id];
          const node = (nodesData.nodes || []).find((n) => n.id === id);
          return {
            id,
            label: known?.name || node?.name || id.charAt(0).toUpperCase() + id.slice(1),
          };
        });

        setConfiguredProviders(providerOptions);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, []);

  const mergeSnapshot = useCallback((prev, next, view) => {
    if (!prev || view === "full") return next;
    if (view === "live") {
      const mergedConnections =
        Array.isArray(prev.connections) && Array.isArray(next.connections)
          ? next.connections.map((nextConn) => {
              const prevConn = prev.connections.find(
                (pc) => pc.connectionId === nextConn.connectionId,
              );
              if (!prevConn) return nextConn;
              return {
                ...prevConn,
                ...nextConn,
                occupiedSlots: nextConn.occupiedSlots,
                availableSlots: nextConn.availableSlots,
                capacity: nextConn.capacity,
                recentAttempts:
                  nextConn.recentAttempts > 0
                    ? nextConn.recentAttempts
                    : prevConn.recentAttempts || 0,
                lastAttemptAt:
                  nextConn.lastAttemptAt || prevConn.lastAttemptAt || null,
                avgTtftMs:
                  nextConn.avgTtftMs > 0
                    ? nextConn.avgTtftMs
                    : prevConn.avgTtftMs || 0,
                p95TtftMs:
                  nextConn.p95TtftMs > 0
                    ? nextConn.p95TtftMs
                    : prevConn.p95TtftMs || 0,
                avgQueueWaitMs:
                  nextConn.avgQueueWaitMs > 0
                    ? nextConn.avgQueueWaitMs
                    : prevConn.avgQueueWaitMs || 0,
                recentTerminalReasonCounts:
                  nextConn.recentTerminalReasonCounts &&
                  Object.keys(nextConn.recentTerminalReasonCounts).length > 0
                    ? nextConn.recentTerminalReasonCounts
                    : prevConn.recentTerminalReasonCounts || {},
              };
            })
          : next.connections || prev.connections;

      return {
        ...prev,
        ...next,
        connections: mergedConnections,
        terminal: prev.terminal,
        models: prev.models,
        paths: prev.paths,
        timeline: prev.timeline,
        aggregates: prev.aggregates,
        latency: prev.latency,
      };
    }
    if (view === "history") {
      return {
        ...prev,
        ...next,
        connections: next.connections || prev.connections,
        terminal: next.terminal || prev.terminal,
        models: next.models || prev.models,
        paths: next.paths || prev.paths,
        timeline: next.timeline || prev.timeline,
        aggregates: next.aggregates || prev.aggregates,
        latency: next.latency || prev.latency,
        generatedAt: next.generatedAt || prev.generatedAt,
      };
    }
    return next;
  }, []);

  const fetchStatus = useCallback(
    async ({ silent = false, view = "full", rangeOverride = null } = {}) => {
      if (silent) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      try {
        const activeRange = rangeOverride || timeRange;
        const url = `/api/dispatcher/text/status?provider=${encodeURIComponent(statusProvider)}&view=${encodeURIComponent(view)}&terminalLimit=100&range=${encodeURIComponent(activeRange)}`;
        const response = await fetch(url, {
          cache: "no-store",
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || "Failed to fetch dispatcher status");
        }
        setSnapshot((prev) => mergeSnapshot(prev, data, view));
      } catch (error) {
        console.error("Failed to fetch dispatcher status:", error);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [statusProvider, timeRange, mergeSnapshot],
  );

  useEffect(() => {
    fetchStatus({ view: "full" });
  }, [fetchStatus]);

  useEffect(() => {
    const liveInterval = setInterval(() => {
      fetchStatus({ silent: true, view: "live" });
    }, LIVE_REFRESH_INTERVAL_MS);
    const historyInterval = setInterval(() => {
      fetchStatus({ silent: true, view: "history" });
    }, HISTORY_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(liveInterval);
      clearInterval(historyInterval);
    };
  }, [fetchStatus]);

  if (loading && !snapshot) {
    return <DispatcherSkeleton />;
  }

  if (!snapshot) {
    return (
      <Card
        title="Dispatcher unavailable"
        subtitle="The operator status payload could not be loaded."
        icon="error"
      >
        <Button variant="outline" icon="refresh" onClick={() => fetchStatus()}>
          Retry
        </Button>
      </Card>
    );
  }

  const currentProviderLabel =
    configuredProviders.find((p) => p.id === statusProvider)?.label ||
    statusProvider.charAt(0).toUpperCase() + statusProvider.slice(1);

  return (
    <div className="flex flex-col gap-5">
      {/* Header & Provider Selector */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          {configuredProviders.map((option) => {
            const selected = statusProvider === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setStatusProvider(option.id)}
                className={`rounded-lg border px-3 py-1.5 text-xs sm:text-sm font-medium transition-all ${
                  selected
                    ? "border-primary bg-primary/10 text-primary shadow-sm"
                    : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            icon={refreshing ? undefined : "refresh"}
            onClick={() => fetchStatus({ silent: true, view: "full" })}
            disabled={refreshing}
          >
            {refreshing ? <Spinner size="sm" /> : "Refresh"}
          </Button>
        </div>
      </div>

      {/* 1. Level 1: Executive Pulse Strip (4 Hero KPI Cards) */}
      <ExecutivePulseStrip
        aggregates={snapshot.aggregates || {}}
        capacity={snapshot.capacity || {}}
        activeCount={snapshot.active?.count || 0}
        queuedCount={snapshot.queued?.count || 0}
        range={timeRange}
      />

      {/* 2. Level 2: Historical Performance Trends & Waterfall */}
      <HistoricalTrendsVisualizer
        timeline={snapshot.timeline || []}
        range={timeRange}
        onRangeChange={(newRange) => {
          setTimeRange(newRange);
          fetchStatus({ silent: true, view: "history", rangeOverride: newRange });
        }}
      />

      {/* 3. Level 3: Workload & Model Intelligence */}
      <ModelPerformanceTable models={snapshot.models || []} range={timeRange} />

      {/* 4. Level 4: Fleet Accounts & Capacity Heatmap */}
      <ConnectionFleetCard
        connections={snapshot.connections || []}
        range={timeRange}
      />

      {/* 5. Level 5: Diagnostics & Guardrails */}
      <DiagnosticsCard
        terminal={snapshot.terminal || {}}
        watchdog={snapshot.watchdog || {}}
        paths={snapshot.paths || []}
      />

      {/* 6. Level 6: Live Execution Drawer & Wait Queue */}
      <LiveExecutionDrawer
        activeAttempts={snapshot.active?.attempts || []}
        queuedRequests={snapshot.queued?.requests || []}
        terminalAttempts={snapshot.terminal?.attempts || []}
      />

      {/* 7. Dispatcher Controls */}
      <DispatcherControlsCard
        snapshot={snapshot}
        provider={statusProvider}
        providerLabel={currentProviderLabel}
        onRefresh={() => fetchStatus({ silent: true })}
        onSettingsApplied={(settingsUpdate) => {
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  settings: {
                    ...current.settings,
                    ...settingsUpdate,
                    dispatcherSlotsPerConnection:
                      settingsUpdate.dispatcherSlotsPerConnection ??
                      current.settings.dispatcherSlotsPerConnection,
                    dispatcherSlotsByProvider:
                      settingsUpdate.dispatcherSlotsByProvider ||
                      current.settings.dispatcherSlotsByProvider,
                  },
                }
              : current,
          );
        }}
      />
    </div>
  );
}
