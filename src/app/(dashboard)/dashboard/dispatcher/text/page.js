"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardSkeleton,
  Input,
  Select,
  Spinner,
} from "@/shared/components";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import DispatcherTimelineChart from "./components/DispatcherTimelineChart";

const LIVE_REFRESH_INTERVAL_MS = 3000;
const HISTORY_REFRESH_INTERVAL_MS = 20000;

function formatTimestamp(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "--";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function formatPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "--";
  return `${Math.round(numeric * 100)}%`;
}

function getModeBadge(mode) {
  if (mode === "managed") {
    return {
      label: "Managed",
      variant: "success",
      description: "Dispatcher owns admission, concurrency slots, and queueing.",
    };
  }
  if (mode === "shadow") {
    return {
      label: "Shadow",
      variant: "warning",
      description: "Ledger records traffic, but requests bypass queueing.",
    };
  }
  return {
    label: "Direct / Off",
    variant: "default",
    description: "Dispatcher is not managing traffic for this provider.",
  };
}

function getHealthBadge(snapshot) {
  const oldestQueueAgeMs = snapshot?.queued?.oldestQueueAgeMs ?? 0;
  const timedOut = snapshot?.terminal?.byState?.timed_out ?? 0;
  const failures = snapshot?.terminal?.byState?.failed ?? 0;

  if (oldestQueueAgeMs > 180000 || timedOut > 0) {
    return { label: "Backlog Alert", variant: "error" };
  }
  if (oldestQueueAgeMs > 30000 || failures > 0) {
    return { label: "Elevated Load", variant: "warning" };
  }
  return { label: "Operational", variant: "success" };
}

function getPathModeLabel(pathMode) {
  if (!pathMode) return "direct";
  return pathMode.replace(/-/g, " ");
}

function StatCard({ title, value, detail, icon, badge, progress = null }) {
  return (
    <Card padding="md" className="min-h-[145px]">
      <div className="flex h-full flex-col justify-between gap-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted/70">
              {title}
            </p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-text-main">
              {value}
            </p>
          </div>
          <div className="flex size-10 items-center justify-center rounded-lg bg-black/[0.03] text-text-muted dark:bg-white/[0.03]">
            <span className="material-symbols-outlined text-[20px]">
              {icon}
            </span>
          </div>
        </div>

        {progress !== null && (
          <div className="space-y-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  progress > 0.8
                    ? "bg-red-500"
                    : progress > 0.6
                      ? "bg-yellow-500"
                      : "bg-primary"
                }`}
                style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-xs text-text-muted truncate">{detail}</p>
          {badge ? <Badge variant={badge.variant} size="sm">{badge.label}</Badge> : null}
        </div>
      </div>
    </Card>
  );
}

function DispatcherOverview({ snapshot, providerLabel }) {
  const health = getHealthBadge(snapshot);
  const totalCapacity = snapshot.capacity.totalCapacity || 0;
  const activeLeases = snapshot.capacity.activeLeases || 0;
  const utilization = totalCapacity > 0 ? activeLeases / totalCapacity : 0;

  const latency = snapshot.latency || {};
  const aggregates = snapshot.aggregates || {};
  const totalVolume = aggregates.totalRequests || snapshot.terminal?.count || 0;
  const totalCompleted = aggregates.totalCompleted || snapshot.terminal?.byState?.completed || 0;
  const totalFailed = aggregates.totalFailed || snapshot.terminal?.byState?.failed || 0;
  const timedOut = snapshot.terminal?.byState?.timed_out || aggregates.totalTimedOut || 0;

  const p50Ttft = latency.p50TtftMs || 0;
  const p95Ttft = latency.p95TtftMs || 0;
  const avgTtft = latency.avgTtftMs || 0;
  const avgQueue = latency.avgQueueWaitMs || 0;
  const p95Queue = latency.p95QueueWaitMs || 0;

  return (
    <div className="flex flex-col gap-4">
      {/* Primary KPI Row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Active Capacity"
          value={`${activeLeases} / ${totalCapacity}`}
          detail={
            snapshot.capacity.activeConnections > 0
              ? `${snapshot.capacity.activeConnections} account(s) · ${snapshot.capacity.availableLeases} slot(s) free`
              : `No active ${providerLabel} accounts currently registered.`
          }
          icon="hub"
          progress={utilization}
          badge={{
            label: formatPercent(utilization),
            variant: utilization > 0.8 ? "error" : utilization > 0.5 ? "warning" : "info",
          }}
        />

        <StatCard
          title="Live Queue"
          value={snapshot.queued.count}
          detail={
            snapshot.queued.count > 0
              ? `Oldest in queue: ${formatDuration(snapshot.queued.oldestQueueAgeMs)}`
              : "Queue clear · Zero wait delay"
          }
          icon="schedule"
          badge={
            snapshot.queued.count > 0
              ? { label: `${snapshot.queued.count} waiting`, variant: "warning" }
              : { label: "Clear", variant: "success" }
          }
        />

        <StatCard
          title="TTFT Latency (p50)"
          value={p50Ttft > 0 ? `${p50Ttft} ms` : "--"}
          detail={`Avg: ${avgTtft} ms · Max: ${latency.maxTtftMs || 0} ms`}
          icon="bolt"
          badge={{
            label: p95Ttft > 0 ? `p95: ${p95Ttft} ms` : "Nominal",
            variant: p95Ttft > 5000 ? "error" : p95Ttft > 2000 ? "warning" : "success",
          }}
        />

        <StatCard
          title="Queue Wait Delay"
          value={avgQueue > 0 ? `${avgQueue} ms` : "< 1 ms"}
          detail={`p50: ${latency.p50QueueWaitMs || 0} ms · Max: ${latency.maxQueueWaitMs || 0} ms`}
          icon="hourglass_top"
          badge={{
            label: p95Queue > 0 ? `p95: ${p95Queue} ms` : "Immediate",
            variant: p95Queue > 5000 ? "error" : p95Queue > 1000 ? "warning" : "success",
          }}
        />
      </div>

      {/* Secondary Operational Row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Throughput Volume"
          value={totalVolume}
          detail={`${totalCompleted} completed · ${totalFailed} failed`}
          icon="monitoring"
          badge={{
            label: health.label,
            variant: health.variant,
          }}
        />

        <StatCard
          title="Watchdog & Timeouts"
          value={timedOut}
          detail={`${snapshot.terminal?.byTimeoutKind?.stream_hang || 0} stream hangs · ${snapshot.terminal?.byTimeoutKind?.queue_expired || 0} queue expired`}
          icon="timer"
          badge={{
            label: timedOut > 0 ? "Timeouts" : "Nominal",
            variant: timedOut > 0 ? "error" : "success",
          }}
        />

        <StatCard
          title="Response Duration"
          value={formatDuration(latency.avgDurationMs || 0)}
          detail="Avg total duration including queue & stream"
          icon="timelapse"
          badge={{
            label: latency.maxDurationMs > 0 ? `Max: ${formatDuration(latency.maxDurationMs)}` : "Nominal",
            variant: "default",
          }}
        />

        <StatCard
          title="Reliability Rate"
          value={
            totalVolume > 0
              ? `${Math.round((totalCompleted / totalVolume) * 100)}%`
              : "100%"
          }
          detail={`Based on ${totalVolume} tracked requests`}
          icon="verified"
          progress={totalVolume > 0 ? totalCompleted / totalVolume : 1}
          badge={{
            label: totalFailed === 0 && timedOut === 0 ? "100% Succeeded" : `${totalFailed + timedOut} Errors`,
            variant: totalFailed === 0 && timedOut === 0 ? "success" : "warning",
          }}
        />
      </div>
    </div>
  );
}

function SummaryTableCard({
  title,
  subtitle,
  icon,
  columns,
  rows,
  emptyLabel,
  headerAction,
}) {
  return (
    <Card title={title} subtitle={subtitle} icon={icon} headerAction={headerAction}>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-black/5 text-left text-xs uppercase tracking-[0.14em] text-text-muted/70 dark:border-white/5">
              {columns.map((column) => (
                <th
                  key={column.key}
                  className="pb-3 pr-4 font-semibold last:pr-0"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length > 0 ? (
              rows.map((row) => (
                <tr
                  key={row.key}
                  className="border-b border-black/[0.04] align-middle last:border-b-0 dark:border-white/[0.04] hover:bg-black/[0.01] dark:hover:bg-white/[0.01] transition-colors"
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className="py-3.5 pr-4 text-text-main last:pr-0 text-sm"
                    >
                      {column.render ? column.render(row) : row[column.key]}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={columns.length}
                  className="py-8 text-center text-sm text-text-muted"
                >
                  {emptyLabel}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ConnectionsTable({ connections, slotsPerConnection }) {
  const rows = connections.map((connection) => {
    const occupied = connection.occupiedSlots || 0;
    const capacity = connection.capacity || slotsPerConnection || 1;
    const ratio = capacity > 0 ? occupied / capacity : 0;

    return {
      key: connection.connectionId,
      connectionName: connection.connectionName,
      occupied,
      capacity,
      ratio,
      lastActivity: formatTimestamp(connection.lastAttemptAt),
      recentAttempts: connection.recentAttempts || 0,
      avgTtftMs: connection.avgTtftMs || 0,
      p95TtftMs: connection.p95TtftMs || 0,
      avgQueueWaitMs: connection.avgQueueWaitMs || 0,
      terminalReasons: Object.entries(
        connection.recentTerminalReasonCounts || {},
      ).map(([reason, count]) => `${reason} (${count})`),
    };
  });

  return (
    <SummaryTableCard
      title="Account Distribution & Capacity Heatmap"
      subtitle="Live slot lease occupancy, latency health, and traffic distribution across active accounts."
      icon="router"
      rows={rows}
      emptyLabel="No active connections are currently configured for this provider."
      columns={[
        {
          key: "connectionName",
          label: "Account Name",
          render: (row) => (
            <div className="flex flex-col">
              <span className="font-medium text-text-main">
                {row.connectionName}
              </span>
              <span className="text-xs text-text-muted">{row.key}</span>
            </div>
          ),
        },
        {
          key: "slots",
          label: "Slot Occupancy",
          render: (row) => (
            <div className="flex flex-col gap-1 w-32">
              <div className="flex justify-between text-xs font-mono">
                <span>{row.occupied} / {row.capacity}</span>
                <span className="text-text-muted">{Math.round(row.ratio * 100)}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    row.ratio > 0.8
                      ? "bg-red-500"
                      : row.ratio > 0.5
                        ? "bg-yellow-500"
                        : "bg-primary"
                  }`}
                  style={{ width: `${Math.min(100, row.ratio * 100)}%` }}
                />
              </div>
            </div>
          ),
        },
        { key: "recentAttempts", label: "Requests" },
        {
          key: "avgTtft",
          label: "Avg TTFT",
          render: (row) => (
            <span className="font-mono text-xs">
              {row.avgTtftMs > 0 ? `${row.avgTtftMs} ms` : "--"}
            </span>
          ),
        },
        {
          key: "p95Ttft",
          label: "p95 TTFT",
          render: (row) => (
            <span
              className={`font-mono text-xs ${
                row.p95TtftMs > 2000 ? "text-amber-500 font-semibold" : ""
              }`}
            >
              {row.p95TtftMs > 0 ? `${row.p95TtftMs} ms` : "--"}
            </span>
          ),
        },
        {
          key: "queueDelay",
          label: "Queue Delay",
          render: (row) => (
            <span className="font-mono text-xs text-text-muted">
              {row.avgQueueWaitMs > 0 ? `${row.avgQueueWaitMs} ms` : "< 1 ms"}
            </span>
          ),
        },
        { key: "lastActivity", label: "Last Active" },
        {
          key: "terminalReasons",
          label: "Diagnostics",
          render: (row) =>
            row.terminalReasons.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {row.terminalReasons.map((reason) => (
                  <span
                    key={reason}
                    className="rounded bg-black/5 px-2 py-0.5 text-xs text-text-muted dark:bg-white/10"
                  >
                    {reason}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-xs text-text-muted">Nominal</span>
            ),
        },
      ]}
    />
  );
}

function ModelsTable({ models }) {
  const rows = models.map((model) => ({
    key: model.modelId,
    name: model.modelId,
    queued: model.queued,
    active: model.active,
    completed: model.completed,
    failures: (model.failed || 0) + (model.timedOut || 0),
    avgTtftMs: model.avgTtftMs || 0,
    p95TtftMs: model.p95TtftMs || 0,
    avgQueueWaitMs: model.avgQueueWaitMs || 0,
    total: model.total,
  }));

  return (
    <SummaryTableCard
      title="Model Throughput, Latency & Outcomes"
      subtitle="Grouped throughput, tail TTFT, and queue wait times by model."
      icon="deployed_code"
      rows={rows}
      emptyLabel="No model activity recorded yet."
      columns={[
        { key: "name", label: "Model ID" },
        { key: "queued", label: "Queued" },
        { key: "active", label: "Active" },
        { key: "completed", label: "Completed" },
        {
          key: "failures",
          label: "Failures",
          render: (row) => (
            <span className={row.failures > 0 ? "text-red-500 font-medium" : "text-text-muted"}>
              {row.failures}
            </span>
          ),
        },
        {
          key: "avgTtft",
          label: "Avg TTFT",
          render: (row) => (
            <span className="font-mono text-xs">
              {row.avgTtftMs > 0 ? `${row.avgTtftMs} ms` : "--"}
            </span>
          ),
        },
        {
          key: "p95Ttft",
          label: "p95 TTFT",
          render: (row) => (
            <span
              className={`font-mono text-xs ${
                row.p95TtftMs > 2000 ? "text-amber-500 font-semibold" : ""
              }`}
            >
              {row.p95TtftMs > 0 ? `${row.p95TtftMs} ms` : "--"}
            </span>
          ),
        },
        {
          key: "queueDelay",
          label: "Queue Delay",
          render: (row) => (
            <span className="font-mono text-xs text-text-muted">
              {row.avgQueueWaitMs > 0 ? `${row.avgQueueWaitMs} ms` : "< 1 ms"}
            </span>
          ),
        },
        { key: "total", label: "Total Handled" },
      ]}
    />
  );
}

function OutcomesBreakdownCard({ terminal }) {
  const byState = terminal?.byState || {};
  const byTimeout = terminal?.byTimeoutKind || {};
  const byReason = terminal?.byTerminalReason || {};

  const total = terminal?.count || 0;
  const completed = byState.completed || 0;
  const failed = byState.failed || 0;
  const timedOut = byState.timed_out || 0;

  const successRate = total > 0 ? Math.round((completed / total) * 100) : 100;

  return (
    <Card
      title="Outcome Diagnostics"
      subtitle="Real-time reliability breakdown and terminal reason distribution."
      icon="troubleshoot"
    >
      <div className="grid gap-6 md:grid-cols-3">
        <div className="flex flex-col justify-center gap-2 rounded-xl bg-black/[0.02] p-4 dark:bg-white/[0.02] border border-black/5 dark:border-white/5">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Success Rate
          </p>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-text-main">{successRate}%</span>
            <span className="text-xs text-text-muted">({completed} / {total})</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10 mt-1">
            <div
              className="h-full bg-green-500 transition-all duration-500"
              style={{ width: `${successRate}%` }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-xl bg-black/[0.02] p-4 dark:bg-white/[0.02] border border-black/5 dark:border-white/5">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Failure Diagnostics
          </p>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-text-muted">Upstream Failures:</span>
              <span className="font-semibold text-red-500">{failed}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Timeouts & Aborts:</span>
              <span className="font-semibold text-yellow-500">{timedOut}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Rate Limits (429):</span>
              <span className="font-semibold text-text-main">{byReason.rate_limited || 0}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-xl bg-black/[0.02] p-4 dark:bg-white/[0.02] border border-black/5 dark:border-white/5">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Watchdog Alarms
          </p>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-text-muted">Stream Hang Aborts:</span>
              <span className="font-medium text-text-main">{byTimeout.stream_hang || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Queue TTL Expired:</span>
              <span className="font-medium text-text-main">{byTimeout.queue_expired || 0}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Client Disconnects:</span>
              <span className="font-medium text-text-main">{byReason.client_aborted || 0}</span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function DispatcherControlsCard({
  snapshot,
  provider,
  providerLabel,
  onSettingsApplied,
  onRefresh,
}) {
  const savedSlots = Number(snapshot.settings.dispatcherSlotsPerConnection || 1);
  const [collections, setCollections] = useState([]);
  const [collectionId, setCollectionId] = useState(
    snapshot.settings.textDispatcherCollectionId || "",
  );
  const [slots, setSlots] = useState(String(savedSlots));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setCollectionId(snapshot.settings.textDispatcherCollectionId || "");
    setSlots(String(snapshot.settings.dispatcherSlotsPerConnection || 1));
    setError("");
    setMessage("");
  }, [
    provider,
    snapshot.settings.textDispatcherCollectionId,
    snapshot.settings.dispatcherSlotsPerConnection,
  ]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/connection-collections", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) {
          setCollections(data.collections || []);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const collectionChanged =
    provider === "codex" &&
    collectionId !== (snapshot.settings.textDispatcherCollectionId || "");
  const slotsChanged = Number(slots) !== savedSlots;
  const hasChanges = collectionChanged || slotsChanged;

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const body = {
        provider,
        dispatcherSlotsPerConnection: Number(slots),
      };
      if (provider === "codex") {
        body.textDispatcherCollectionId = collectionId;
      }
      const response = await fetch("/api/dispatcher/text/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to update dispatcher settings");
      }
      setMessage(`${providerLabel} slots updated to ${slots} (isolated pool).`);
      onSettingsApplied(data);
      await onRefresh();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={`${providerLabel} Dispatcher Settings`}
      subtitle={`Concurrency slots and routing controls for ${providerLabel}.`}
      icon="tune"
    >
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card.Section className="flex flex-col gap-3">
          {provider === "codex" ? (
            <Select
              label="Connection Collection Scope"
              value={collectionId}
              onChange={(event) => setCollectionId(event.target.value)}
              options={collections.map((collection) => ({
                value: collection.id,
                label: collection.name,
              }))}
              placeholder="Select collection (or all connections)"
              hint="Only active Codex connections in this collection are eligible for text dispatch."
            />
          ) : (
            <div className="rounded-lg border border-black/5 bg-black/[0.02] p-3 text-sm text-text-muted dark:border-white/5 dark:bg-white/[0.02]">
              {providerLabel} operates with all active accounts registered for this provider.
            </div>
          )}
        </Card.Section>

        <Card.Section className="flex flex-col justify-between gap-3">
          <Input
            label="Concurrency Slots Per Account"
            type="number"
            min={1}
            max={100}
            value={slots}
            onChange={(event) => setSlots(event.target.value)}
            hint="Max active leases per account before queueing."
          />
          <div className="flex items-center gap-2 pt-2">
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!hasChanges || saving}
            >
              {saving ? <Spinner size="sm" /> : "Save Changes"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCollectionId(
                  snapshot.settings.textDispatcherCollectionId || "",
                );
                setSlots(String(savedSlots));
                setError("");
                setMessage("");
              }}
              disabled={!hasChanges || saving}
            >
              Reset
            </Button>
          </div>
          {error ? (
            <p className="text-xs text-red-500">{error}</p>
          ) : message ? (
            <p className="text-xs text-green-600 dark:text-green-400">
              {message}
            </p>
          ) : null}
        </Card.Section>
      </div>
    </Card>
  );
}

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
      return {
        ...prev,
        ...next,
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
    <div className="flex flex-col gap-6">
      {/* Header & Provider Selector */}
      <div className="flex flex-wrap items-center justify-between gap-4">
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
                    : "border-black/10 text-text-muted hover:border-black/20 dark:border-white/10 hover:text-text-main"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
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

      {/* Overview Stat Cards */}
      <DispatcherOverview snapshot={snapshot} providerLabel={currentProviderLabel} />

      {/* Historical Throughput & Latency Timeline */}
      <DispatcherTimelineChart
        timeline={snapshot.timeline || []}
        range={timeRange}
        onRangeChange={(r) => {
          setTimeRange(r);
          fetchStatus({ silent: true, view: "history", rangeOverride: r });
        }}
        refreshing={refreshing}
      />

      {/* Outcome Diagnostics & Watchdog Alarms */}
      <OutcomesBreakdownCard terminal={snapshot.terminal} />

      {/* Dispatcher Controls */}
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

      {/* Account Distribution Heatmap */}
      <ConnectionsTable
        connections={snapshot.connections || []}
        slotsPerConnection={snapshot.capacity.slotsPerConnection}
      />

      {/* Model Activity */}
      <ModelsTable models={snapshot.models || []} />
    </div>
  );
}
