"use client";

import { useState, useEffect } from "react";
import { Card, Input, Select, Button, Spinner } from "@/shared/components";

export default function DispatcherControlsCard({
  snapshot,
  provider,
  providerLabel,
  onRefresh,
  onSettingsApplied,
}) {
  const savedSlots = Number(snapshot?.settings?.dispatcherSlotsPerConnection || 1);
  const [collections, setCollections] = useState([]);
  const [collectionId, setCollectionId] = useState(
    snapshot?.settings?.textDispatcherCollectionId || "",
  );
  const [slots, setSlots] = useState(String(savedSlots));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setCollectionId(snapshot?.settings?.textDispatcherCollectionId || "");
    setSlots(String(snapshot?.settings?.dispatcherSlotsPerConnection || 1));
    setError("");
    setMessage("");
  }, [
    provider,
    snapshot?.settings?.textDispatcherCollectionId,
    snapshot?.settings?.dispatcherSlotsPerConnection,
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
    collectionId !== (snapshot?.settings?.textDispatcherCollectionId || "");
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
                  snapshot?.settings?.textDispatcherCollectionId || "",
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
