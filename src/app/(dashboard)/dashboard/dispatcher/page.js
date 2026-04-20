"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardSkeleton,
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

function getAttemptSummary(attempt) {
  const queueWaitMs =
    attempt?.leasedAt && attempt?.queueEnteredAt
      ? new Date(attempt.leasedAt).getTime() -
        new Date(attempt.queueEnteredAt).getTime()
      : null;
  const connectToFirstProgressMs =
    attempt?.firstProgressAt && attempt?.connectStartedAt
      ? new Date(attempt.firstProgressAt).getTime() -
        new Date(attempt.connectStartedAt).getTime()
      : null;

  const endTimestamp =
    attempt?.finishedAt ||
    attempt?.lastProgressAt ||
    attempt?.firstProgressAt ||
    attempt?.streamStartedAt ||
    attempt?.connectStartedAt ||
    null;
  const totalRuntimeMs =
    endTimestamp && attempt?.queueEnteredAt
      ? new Date(endTimestamp).getTime() -
        new Date(attempt.queueEnteredAt).getTime()
      : null;

  return {
    queueWaitMs,
    connectToFirstProgressMs,
    totalRuntimeMs,
  };
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
  const mode = getModeBadge(snapshot.mode);
  const health = getHealthBadge(snapshot);

  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="Mode"
        value={mode.label}
        detail={mode.description}
        icon="toggle_on"
        badge={{ label: health.label, variant: health.variant }}
      />
      <StatCard
        title="Capacity"
        value={`${snapshot.capacity.activeLeases}/${snapshot.capacity.totalCapacity}`}
        detail={`${snapshot.capacity.activeConnections} active connections · ${snapshot.capacity.availableLeases} lease(s) free`}
        icon="hub"
        badge={{
          label: formatPercent(snapshot.capacity.utilization),
          variant: "info",
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

function DispatcherSummaryCard({ snapshot, onRefresh, refreshing }) {
  return (
    <Card
      title="Dispatcher summary"
      subtitle="Read-only operator view for Codex admission, queue health, and slot usage."
      icon="monitoring"
      action={
        <div className="flex items-center gap-2">
          <Badge variant={getHealthBadge(snapshot).variant} dot>
            {getHealthBadge(snapshot).label}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            icon={refreshing ? undefined : "refresh"}
            onClick={onRefresh}
            disabled={refreshing}
          >
            {refreshing ? <Spinner size="sm" /> : "Refresh"}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="grid gap-3 sm:grid-cols-2">
          <Card.Section>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted/70">
              Generated
            </p>
            <p className="mt-2 text-sm font-medium text-text-main">
              {formatTimestamp(snapshot.generatedAt)}
            </p>
          </Card.Section>
          <Card.Section>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted/70">
              Slots / Connection
            </p>
            <p className="mt-2 text-sm font-medium text-text-main">
              {snapshot.settings.dispatcherSlotsPerConnection}
            </p>
          </Card.Section>
          <Card.Section>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted/70">
              Codex only
            </p>
            <p className="mt-2 text-sm font-medium text-text-main">
              {snapshot.settings.dispatcherCodexOnly ? "Yes" : "No"}
            </p>
          </Card.Section>
          <Card.Section>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted/70">
              Timeout policy
            </p>
            <p className="mt-2 text-sm font-medium text-text-main">
              Queue TTL{" "}
              {formatDuration(snapshot.watchdog?.timeoutPolicy?.queueTtlMs)}
            </p>
          </Card.Section>
        </div>
        <Card.Section className="flex flex-col gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-muted">Path mix</span>
            <span className="font-medium text-text-main">
              {Object.keys(snapshot.active.byPathMode || {}).length || 0} active
              path(s)
            </span>
          </div>
          <div className="space-y-2">
            {Object.entries(snapshot.active.byPathMode || {}).length > 0 ? (
              Object.entries(snapshot.active.byPathMode).map(
                ([pathMode, count]) => (
                  <div
                    key={pathMode}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-text-muted capitalize">
                      {getPathModeLabel(pathMode)}
                    </span>
                    <span className="font-medium text-text-main">{count}</span>
                  </div>
                ),
              )
            ) : (
              <p className="text-sm text-text-muted">
                No active attempts right now.
              </p>
            )}
          </div>
        </Card.Section>
      </div>
    </Card>
  );
}

function ConnectionsTable({ connections }) {
  return (
    <Card
      title="Connection occupancy"
      subtitle="Per-account slot usage and recent terminal reasons."
      icon="router"
    >
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-black/5 text-left text-xs uppercase tracking-[0.16em] text-text-muted/70 dark:border-white/5">
              <th className="pb-3 pr-4 font-semibold">Connection</th>
              <th className="pb-3 pr-4 font-semibold">Slots</th>
              <th className="pb-3 pr-4 font-semibold">Proxy</th>
              <th className="pb-3 pr-4 font-semibold">Recent attempts</th>
              <th className="pb-3 pr-4 font-semibold">Last activity</th>
              <th className="pb-3 font-semibold">Terminal reasons</th>
            </tr>
          </thead>
          <tbody>
            {connections.map((connection) => (
              <tr
                key={connection.connectionId}
                className="border-b border-black/[0.04] align-top dark:border-white/[0.04]"
              >
                <td className="py-4 pr-4">
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-text-main">
                      {connection.connectionName}
                    </span>
                    <span className="text-xs text-text-muted">
                      {connection.connectionId}
                    </span>
                  </div>
                </td>
                <td className="py-4 pr-4">
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text-main">
                        {connection.occupiedSlots}/{connection.capacity}
                      </span>
                      <Badge
                        variant={
                          connection.occupiedSlots > 0 ? "primary" : "default"
                        }
                        size="sm"
                      >
                        {connection.availableSlots} free
                      </Badge>
                    </div>
                    <div className="h-2 w-36 overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.05]">
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{
                          width: `${Math.max(
                            6,
                            (connection.occupiedSlots /
                              Math.max(1, connection.capacity)) *
                              100,
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                </td>
                <td className="py-4 pr-4">
                  <div className="flex flex-col gap-1">
                    <Badge
                      variant={connection.strictProxy ? "success" : "default"}
                      size="sm"
                    >
                      {connection.strictProxy
                        ? "Strict proxy"
                        : "Flexible path"}
                    </Badge>
                    <span className="text-xs text-text-muted">
                      {connection.proxyPoolId || "No pool"}
                    </span>
                  </div>
                </td>
                <td className="py-4 pr-4 text-text-main">
                  {connection.recentAttempts}
                </td>
                <td className="py-4 pr-4 text-text-muted">
                  {formatTimestamp(connection.lastAttemptAt)}
                </td>
                <td className="py-4">
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(connection.recentTerminalReasonCounts || {})
                      .length > 0 ? (
                      Object.entries(connection.recentTerminalReasonCounts).map(
                        ([reason, count]) => (
                          <Badge key={reason} variant="default" size="sm">
                            {reason}: {count}
                          </Badge>
                        ),
                      )
                    ) : (
                      <span className="text-xs text-text-muted">
                        No recent terminal events
                      </span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function AttemptsTable({ attempts }) {
  return (
    <Card
      title="Recent attempts"
      subtitle="Latest active and terminal attempts with queue and runtime timing."
      icon="history"
    >
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-black/5 text-left text-xs uppercase tracking-[0.16em] text-text-muted/70 dark:border-white/5">
              <th className="pb-3 pr-4 font-semibold">Request</th>
              <th className="pb-3 pr-4 font-semibold">Connection</th>
              <th className="pb-3 pr-4 font-semibold">State</th>
              <th className="pb-3 pr-4 font-semibold">Path</th>
              <th className="pb-3 pr-4 font-semibold">Queue wait</th>
              <th className="pb-3 pr-4 font-semibold">
                Connect - first progress
              </th>
              <th className="pb-3 pr-4 font-semibold">Runtime</th>
              <th className="pb-3 font-semibold">Terminal</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((attempt) => {
              const summary = getAttemptSummary(attempt);
              return (
                <tr
                  key={attempt.id}
                  className="border-b border-black/[0.04] align-top dark:border-white/[0.04]"
                >
                  <td className="py-4 pr-4">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-text-main">
                        {attempt.requestId}
                      </span>
                      <span className="text-xs text-text-muted">
                        {attempt.request?.modelId || attempt.modelId}
                      </span>
                    </div>
                  </td>
                  <td className="py-4 pr-4 text-text-muted">
                    {attempt.connectionId || "--"}
                  </td>
                  <td className="py-4 pr-4">
                    <Badge
                      variant={
                        attempt.state === "streaming"
                          ? "success"
                          : attempt.state === "failed" ||
                              attempt.state === "timed_out"
                            ? "error"
                            : "default"
                      }
                      size="sm"
                    >
                      {attempt.state}
                    </Badge>
                  </td>
                  <td className="py-4 pr-4 text-text-muted capitalize">
                    {getPathModeLabel(attempt.pathMode)}
                  </td>
                  <td className="py-4 pr-4 text-text-main">
                    {formatDuration(summary.queueWaitMs)}
                  </td>
                  <td className="py-4 pr-4 text-text-main">
                    {formatDuration(summary.connectToFirstProgressMs)}
                  </td>
                  <td className="py-4 pr-4 text-text-main">
                    {formatDuration(summary.totalRuntimeMs)}
                  </td>
                  <td className="py-4">
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-text-main">
                        {attempt.terminalReason || "--"}
                      </span>
                      <span className="text-xs text-text-muted">
                        {formatTimestamp(
                          attempt.finishedAt ||
                            attempt.lastProgressAt ||
                            attempt.firstProgressAt,
                        )}
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
  const [attemptFilter, setAttemptFilter] = useState("all");

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

  const filteredAttempts = useMemo(() => {
    if (!snapshot?.recentAttempts) return [];
    if (attemptFilter === "active") {
      return snapshot.recentAttempts.filter((attempt) =>
        ["queued", "leased", "connecting", "streaming"].includes(attempt.state),
      );
    }
    if (attemptFilter === "terminal") {
      return snapshot.recentAttempts.filter((attempt) =>
        [
          "completed",
          "failed",
          "timed_out",
          "cancelled",
          "reconciled",
        ].includes(attempt.state),
      );
    }
    return snapshot.recentAttempts;
  }, [attemptFilter, snapshot]);

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
      <DispatcherSummaryCard
        snapshot={snapshot}
        onRefresh={() => fetchStatus({ silent: true })}
        refreshing={refreshing}
      />
      <DispatcherOverview snapshot={snapshot} />
      <ConnectionsTable connections={snapshot.connections || []} />
      <Card
        title="Recent activity"
        subtitle="Switch between all, active, or terminal attempts without leaving the page."
        icon="timeline"
        action={
          <SegmentedControl
            options={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "terminal", label: "Terminal" },
            ]}
            value={attemptFilter}
            onChange={setAttemptFilter}
            size="sm"
          />
        }
      >
        <AttemptsTable attempts={filteredAttempts} />
      </Card>
    </div>
  );
}
