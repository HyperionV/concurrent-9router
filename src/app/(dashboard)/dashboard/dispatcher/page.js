"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardSkeleton,
  Input,
  SegmentedControl,
  Spinner,
} from "@/shared/components";

const REFRESH_INTERVAL_MS = 5000;

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
      description: "Dispatcher owns admission and slot control.",
    };
  }
  if (mode === "shadow") {
    return {
      label: "Shadow",
      variant: "warning",
      description:
        "Ledger records traffic, but legacy routing still executes requests.",
    };
  }
  return {
    label: "Off",
    variant: "default",
    description: "Dispatcher is not participating in runtime traffic.",
  };
}

function getHealthBadge(snapshot) {
  const oldestQueueAgeMs = snapshot?.queued?.oldestQueueAgeMs ?? 0;
  const timedOut = snapshot?.terminal?.byState?.timed_out ?? 0;
  const failures = snapshot?.terminal?.byState?.failed ?? 0;

  if (oldestQueueAgeMs > 180000 || timedOut > 0) {
    return { label: "At Risk", variant: "error" };
  }
  if (oldestQueueAgeMs > 30000 || failures > 0) {
    return { label: "Watch", variant: "warning" };
  }
  return { label: "Healthy", variant: "success" };
}

function getPathModeLabel(pathMode) {
  if (!pathMode) return "unknown";
  return pathMode.replace(/-/g, " ");
}

function StatCard({ title, value, detail, icon, badge }) {
  return (
    <Card padding="md" className="min-h-[140px]">
      <div className="flex h-full flex-col justify-between gap-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-text-muted/70">
              {title}
            </p>
            <p className="mt-3 text-3xl font-semibold tracking-tight text-text-main">
              {value}
            </p>
          </div>
          <div className="flex size-10 items-center justify-center rounded-lg bg-black/[0.03] text-text-muted dark:bg-white/[0.03]">
            <span className="material-symbols-outlined text-[20px]">
              {icon}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-text-muted">{detail}</p>
          {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
        </div>
      </div>
    </Card>
  );
}

function DispatcherOverview({ snapshot }) {
  const health = getHealthBadge(snapshot);

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <StatCard
        title="Capacity"
        value={`${snapshot.capacity.activeLeases}/${snapshot.capacity.totalCapacity}`}
        detail={
          snapshot.capacity.activeConnections > 0
            ? `${snapshot.capacity.activeConnections} active connections · ${snapshot.capacity.availableLeases} lease(s) free`
            : "No active Codex connections are currently available to the dispatcher."
        }
        icon="hub"
        badge={{
          label:
            snapshot.capacity.activeConnections > 0
              ? formatPercent(snapshot.capacity.utilization)
              : health.label,
          variant:
            snapshot.capacity.activeConnections > 0 ? "info" : health.variant,
        }}
      />
      <StatCard
        title="Queue"
        value={snapshot.queued.count}
        detail={`Oldest queued: ${formatDuration(snapshot.queued.oldestQueueAgeMs)}`}
        icon="schedule"
      />
      <StatCard
        title="Recent terminals"
        value={snapshot.terminal.count}
        detail={`${snapshot.terminal.byState.failed || 0} failed · ${snapshot.terminal.byState.timed_out || 0} timed out`}
        icon="monitoring"
      />
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
}) {
  return (
    <Card title={title} subtitle={subtitle} icon={icon}>
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-black/5 text-left text-xs uppercase tracking-[0.16em] text-text-muted/70 dark:border-white/5">
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
                  className="border-b border-black/[0.04] align-top last:border-b-0 dark:border-white/[0.04]"
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className="py-4 pr-4 text-text-main last:pr-0"
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
                  className="py-6 text-sm text-text-muted"
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

function ModelsTable({ models }) {
  const rows = models.map((model) => ({
    key: model.modelId,
    name: model.modelId,
    queued: model.queued,
    active: model.active,
    completed: model.completed,
    failures: model.failed + model.timedOut,
    total: model.total,
  }));

  return (
    <SummaryTableCard
      title="Model distribution"
      subtitle="Grouped throughput and terminal outcomes by model."
      icon="deployed_code"
      rows={rows}
      emptyLabel="No model activity has been recorded yet."
      columns={[
        { key: "name", label: "Model" },
        { key: "queued", label: "Queued" },
        { key: "active", label: "Active" },
        { key: "completed", label: "Completed" },
        { key: "failures", label: "Failures" },
        { key: "total", label: "Total" },
      ]}
    />
  );
}

function PathsTable({ paths }) {
  const rows = paths.map((pathSummary) => ({
    key: pathSummary.pathMode,
    pathMode: pathSummary.pathMode,
    active: pathSummary.active,
    completed: pathSummary.completed,
    failed: pathSummary.failed,
    timedOut: pathSummary.timedOut,
    total: pathSummary.total,
  }));

  return (
    <SummaryTableCard
      title="Path performance"
      subtitle="Grouped outcomes by execution path."
      icon="route"
      rows={rows}
      emptyLabel="No path data is available yet."
      columns={[
        {
          key: "pathMode",
          label: "Path",
          render: (row) => (
            <span className="capitalize">{getPathModeLabel(row.pathMode)}</span>
          ),
        },
        { key: "active", label: "Active" },
        { key: "completed", label: "Completed" },
        { key: "failed", label: "Failed" },
        { key: "timedOut", label: "Timed out" },
        { key: "total", label: "Total" },
      ]}
    />
  );
}

function ConnectionsTable({ connections }) {
  const rows = connections.map((connection) => ({
    key: connection.connectionId,
    connectionName: connection.connectionName,
    capacity: `${connection.occupiedSlots}/${connection.capacity}`,
    lastActivity: formatTimestamp(connection.lastAttemptAt),
    recentAttempts: connection.recentAttempts,
    proxy: connection.strictProxy ? "Strict proxy" : "Flexible path",
    proxyPoolId: connection.proxyPoolId || "No pool",
    terminalReasons: Object.entries(
      connection.recentTerminalReasonCounts || {},
    ).map(([reason, count]) => `${reason}: ${count}`),
  }));

  return (
    <SummaryTableCard
      title="Account distribution"
      subtitle="How live capacity and recent outcomes are spread across accounts."
      icon="router"
      rows={rows}
      emptyLabel="No active Codex connections are available."
      columns={[
        {
          key: "connectionName",
          label: "Account",
          render: (row) => (
            <div className="flex flex-col gap-1">
              <span className="font-medium text-text-main">
                {row.connectionName}
              </span>
              <span className="text-xs text-text-muted">{row.proxyPoolId}</span>
            </div>
          ),
        },
        { key: "capacity", label: "Slots" },
        { key: "recentAttempts", label: "Recent activity" },
        { key: "lastActivity", label: "Last activity" },
        {
          key: "proxy",
          label: "Path policy",
          render: (row) => (
            <Badge
              variant={row.proxy === "Strict proxy" ? "success" : "default"}
              size="sm"
            >
              {row.proxy}
            </Badge>
          ),
        },
        {
          key: "terminalReasons",
          label: "Terminal reasons",
          render: (row) =>
            row.terminalReasons.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {row.terminalReasons.map((reason) => (
                  <div
                    key={reason}
                    className="rounded-full bg-black/5 px-2 py-1 text-xs text-text-muted dark:bg-white/10"
                  >
                    {reason}
                  </div>
                ))}
              </div>
            ) : (
              <span className="text-xs text-text-muted">
                No recent terminal events
              </span>
            ),
        },
      ]}
    />
  );
}

function DispatcherControlsCard({ snapshot, onSettingsApplied, onRefresh }) {
  const [mode, setMode] = useState(snapshot.mode);
  const [slots, setSlots] = useState(
    String(snapshot.settings.dispatcherSlotsPerConnection || 1),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setMode(snapshot.mode);
    setSlots(String(snapshot.settings.dispatcherSlotsPerConnection || 1));
  }, [snapshot.mode, snapshot.settings.dispatcherSlotsPerConnection]);

  const hasChanges =
    mode !== snapshot.mode ||
    Number(slots) !==
      Number(snapshot.settings.dispatcherSlotsPerConnection || 1);

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/dispatcher/settings", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode,
          dispatcherSlotsPerConnection: Number(slots),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to update dispatcher settings");
      }
      setMessage("Dispatcher settings updated.");
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
      title="Dispatcher controls"
      subtitle="Choose the operating mode and concurrency ceiling for Codex accounts."
      icon="tune"
    >
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card.Section className="flex flex-col gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted/70">
              Runtime mode
            </p>
            <p className="mt-2 text-sm text-text-muted">
              `Off` disables dispatcher participation, `Shadow` records
              dispatcher telemetry without controlling traffic, and `Managed`
              enables real queueing and slot control.
            </p>
          </div>
          <SegmentedControl
            options={[
              { value: "off", label: "Off" },
              { value: "shadow", label: "Shadow" },
              { value: "managed", label: "Managed" },
            ]}
            value={mode}
            onChange={setMode}
          />
        </Card.Section>

        <Card.Section className="flex flex-col gap-3">
          <Input
            label="Slots per connection"
            type="number"
            min="1"
            max="20"
            value={slots}
            onChange={(event) => setSlots(event.target.value)}
            hint="Applies to active Codex connections. Increase cautiously as you validate stability."
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={!hasChanges}
              loading={saving}
            >
              Apply
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setMode(snapshot.mode);
                setSlots(
                  String(snapshot.settings.dispatcherSlotsPerConnection || 1),
                );
                setError("");
                setMessage("");
              }}
              disabled={!hasChanges || saving}
            >
              Reset
            </Button>
          </div>
          {error ? (
            <p className="text-sm text-red-500">{error}</p>
          ) : message ? (
            <p className="text-sm text-green-600 dark:text-green-400">
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
    <div className="flex flex-col gap-4">
      <CardSkeleton />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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

  const fetchStatus = useCallback(async ({ silent = false } = {}) => {
    if (silent) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      const response = await fetch("/api/dispatcher/status", {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to fetch dispatcher status");
      }
      setSnapshot(data);
    } catch (error) {
      console.error("Failed to fetch dispatcher status:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchStatus({ silent: true });
    }, REFRESH_INTERVAL_MS);

    return () => clearInterval(interval);
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

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          icon={refreshing ? undefined : "refresh"}
          onClick={() => fetchStatus({ silent: true })}
          disabled={refreshing}
        >
          {refreshing ? <Spinner size="sm" /> : "Refresh"}
        </Button>
      </div>
      <DispatcherOverview snapshot={snapshot} />
      <DispatcherControlsCard
        snapshot={snapshot}
        onRefresh={() => fetchStatus({ silent: true })}
        onSettingsApplied={(settingsUpdate) => {
          setSnapshot((current) =>
            current
              ? {
                  ...current,
                  mode: settingsUpdate.mode,
                  settings: {
                    ...current.settings,
                    ...settingsUpdate,
                  },
                }
              : current,
          );
        }}
      />
      <div className="grid gap-6 xl:grid-cols-2">
        <ConnectionsTable connections={snapshot.connections || []} />
        <ModelsTable models={snapshot.models || []} />
      </div>
      <PathsTable paths={snapshot.paths || []} />
    </div>
  );
}
