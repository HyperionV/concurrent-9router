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

const REFRESH_INTERVAL_MS = 5000;

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "--";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  return `${(value / 60_000).toFixed(1)} min`;
}

function formatTimestamp(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
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

function SummaryTable({ title, subtitle, icon, columns, rows, emptyLabel }) {
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

function ImageDispatcherSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <CardSkeleton />
      <div className="grid gap-4 md:grid-cols-3">
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
      <CardSkeleton />
    </div>
  );
}

export default function ImageDispatcherPage() {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [collections, setCollections] = useState([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [slotsPerConnection, setSlotsPerConnection] = useState("1");
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [settingsMessage, setSettingsMessage] = useState("");

  const fetchStatus = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    try {
      const response = await fetch("/api/dispatcher/image/status", {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to fetch image dispatcher");
      }
      setSnapshot(data);
    } catch (error) {
      console.error("Failed to fetch image dispatcher status:", error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/connection-collections", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setCollections(data.collections || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const nextCollectionId =
      snapshot?.settings?.imageDispatcherCollectionId || "";
    const nextSlotsPerConnection = String(
      snapshot?.settings?.imageDispatcherSlotsPerConnection || 1,
    );
    const isDirty =
      selectedCollectionId !== "" &&
      (selectedCollectionId !== nextCollectionId ||
        String(Number(slotsPerConnection)) !== nextSlotsPerConnection);

    if (isDirty) return;

    setSelectedCollectionId(nextCollectionId);
    setSlotsPerConnection(nextSlotsPerConnection);
    setSettingsError("");
    setSettingsMessage("");
  }, [
    selectedCollectionId,
    slotsPerConnection,
    snapshot?.settings?.imageDispatcherCollectionId,
    snapshot?.settings?.imageDispatcherSlotsPerConnection,
  ]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchStatus({ silent: true });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  if (loading && !snapshot) return <ImageDispatcherSkeleton />;

  if (!snapshot) {
    return (
      <Card
        title="Image dispatcher unavailable"
        subtitle="The image dispatcher status payload could not be loaded."
        icon="error"
      >
        <Button variant="outline" icon="refresh" onClick={() => fetchStatus()}>
          Retry
        </Button>
      </Card>
    );
  }

  const terminalRows = (snapshot.terminal?.recent || []).map((attempt) => ({
    key: attempt.id,
    model: attempt.modelId,
    connection: attempt.connectionId || "none",
    state: attempt.state,
    reason: attempt.terminalReason || "unknown",
    finishedAt: formatTimestamp(attempt.finishedAt),
  }));
  const savedCollectionId =
    snapshot.settings?.imageDispatcherCollectionId || "";
  const savedSlotsPerConnection = String(
    snapshot.settings?.imageDispatcherSlotsPerConnection || 1,
  );
  const settingsChanged =
    selectedCollectionId !== savedCollectionId ||
    String(Number(slotsPerConnection)) !== savedSlotsPerConnection;

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    setSettingsError("");
    setSettingsMessage("");
    try {
      const response = await fetch("/api/dispatcher/image/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDispatcherCollectionId: selectedCollectionId,
          imageDispatcherSlotsPerConnection: Number(slotsPerConnection),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data?.error || "Failed to update image dispatcher settings",
        );
      }
      setSettingsMessage("Image dispatcher settings updated.");
      await fetchStatus({ silent: true });
    } catch (error) {
      setSettingsError(error.message);
    } finally {
      setSavingSettings(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <Card
          title="Image dispatcher"
          subtitle="Always-on Codex image queue. Capacity uses an image-only slot limit per account and stays independent from text dispatcher slots."
          icon="image"
          className="flex-1"
        />
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

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          title="Capacity"
          value={`${snapshot.capacity.activeLeases}/${snapshot.capacity.totalCapacity}`}
          detail={`${snapshot.capacity.activeConnections} active Codex account(s), ${snapshot.capacity.capacityPerConnection} image slot(s) each.`}
          icon="hub"
          badge={{ label: "Always on", variant: "success" }}
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
          detail={`${snapshot.terminal.byState?.failed || 0} failed, ${snapshot.terminal.byState?.timed_out || 0} timed out`}
          icon="monitoring"
        />
      </div>

      <Card
        title="Dispatcher Configuration"
        subtitle="Only active Codex accounts in this collection are eligible for image dispatch."
        icon="inventory_2"
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              onClick={handleSaveSettings}
              disabled={!settingsChanged}
              loading={savingSettings}
            >
              Apply
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setSelectedCollectionId(savedCollectionId);
                setSlotsPerConnection(savedSlotsPerConnection);
                setSettingsError("");
                setSettingsMessage("");
              }}
              disabled={!settingsChanged || savingSettings}
            >
              Reset
            </Button>
          </div>
        }
      >
        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <Card.Section className="flex flex-col gap-3">
            <Select
              label="Image collection"
              value={selectedCollectionId}
              onChange={(event) => setSelectedCollectionId(event.target.value)}
              options={collections.map((collection) => ({
                value: collection.id,
                label: collection.name,
              }))}
              placeholder="Select collection"
              hint="Only active Codex accounts in this collection are eligible for image dispatch."
            />
            {settingsError ? (
              <p className="text-sm text-red-500">{settingsError}</p>
            ) : settingsMessage ? (
              <p className="text-sm text-green-600 dark:text-green-400">
                {settingsMessage}
              </p>
            ) : null}
          </Card.Section>
          <Card.Section className="flex flex-col gap-3">
            <Input
              label="Slots per connection"
              type="number"
              min="1"
              max="20"
              value={slotsPerConnection}
              onChange={(event) => setSlotsPerConnection(event.target.value)}
              hint="Image-only capacity. Increase cautiously after validating account stability."
            />
          </Card.Section>
        </div>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <SummaryTable
          title="Account occupancy"
          subtitle="Image slots are separate from text dispatcher capacity."
          icon="router"
          rows={(snapshot.connections || []).map((connection) => ({
            key: connection.connectionId,
            name: connection.connectionName,
            capacity: `${connection.occupiedSlots}/${connection.capacity}`,
          }))}
          emptyLabel="No active Codex image accounts are available."
          columns={[
            { key: "name", label: "Account" },
            { key: "capacity", label: "Slot" },
          ]}
        />

        <SummaryTable
          title="Active attempts"
          subtitle="Requests currently holding an image slot."
          icon="motion_photos_on"
          rows={(snapshot.activeAttempts || []).map((attempt) => ({
            key: attempt.id,
            model: attempt.modelId,
            connection: attempt.connectionId || "none",
            state: attempt.state,
            started: formatTimestamp(
              attempt.streamStartedAt ||
                attempt.connectStartedAt ||
                attempt.leasedAt,
            ),
          }))}
          emptyLabel="No image requests are active."
          columns={[
            { key: "model", label: "Model" },
            { key: "connection", label: "Account" },
            { key: "state", label: "State" },
            { key: "started", label: "Started" },
          ]}
        />
      </div>

      <SummaryTable
        title="Recent terminal attempts"
        subtitle="Durable completion, failure, timeout, and cancellation records."
        icon="history"
        rows={terminalRows}
        emptyLabel="No image dispatcher terminal attempts are recorded yet."
        columns={[
          { key: "model", label: "Model" },
          { key: "connection", label: "Account" },
          { key: "state", label: "State" },
          { key: "reason", label: "Reason" },
          { key: "finishedAt", label: "Finished" },
        ]}
      />
    </div>
  );
}
