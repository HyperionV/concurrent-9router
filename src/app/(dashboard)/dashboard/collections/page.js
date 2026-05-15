"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardSkeleton,
  Input,
  Modal,
  Toggle,
} from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

function CollectionsPageSkeleton() {
  return (
    <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
      <CardSkeleton />
      <CardSkeleton />
    </div>
  );
}

function sortByName(items = []) {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function getCollectionStatus(connections = [], collectionId) {
  const members = connections.filter((connection) =>
    (connection.collectionIds || []).includes(collectionId),
  );
  const active = members.filter(
    (connection) => connection.isActive !== false,
  ).length;
  const disabled = members.length - active;

  return {
    active,
    disabled,
    isOn: members.length > 0 && disabled === 0,
    total: members.length,
  };
}

export default function CollectionsPage() {
  const notify = useNotificationStore();
  const menuRef = useRef(null);
  const [collections, setCollections] = useState([]);
  const [connections, setConnections] = useState([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingMemberships, setSavingMemberships] = useState(false);
  const [actionMenuId, setActionMenuId] = useState(null);
  const [editingCollectionId, setEditingCollectionId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [pendingAddIds, setPendingAddIds] = useState([]);
  const [savingCollectionStatus, setSavingCollectionStatus] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [collectionsRes, connectionsRes] = await Promise.all([
        fetch("/api/connection-collections", { cache: "no-store" }),
        fetch("/api/providers", { cache: "no-store" }),
      ]);

      const collectionsData = collectionsRes.ok
        ? await collectionsRes.json()
        : { collections: [] };
      const connectionsData = connectionsRes.ok
        ? await connectionsRes.json()
        : { connections: [] };

      const nextCollections = sortByName(collectionsData.collections || []);
      const nextConnections = sortByName(connectionsData.connections || []);

      setCollections(nextCollections);
      setConnections(nextConnections);
      setSelectedCollectionId((current) => {
        if (
          current &&
          nextCollections.some((collection) => collection.id === current)
        ) {
          return current;
        }
        return nextCollections[0]?.id || null;
      });
    } catch (error) {
      console.error("Failed to fetch collections:", error);
      notify.error("Failed to load collections");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setActionMenuId(null);
      }
    };
    if (actionMenuId) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }
  }, [actionMenuId]);

  const selectedCollection = useMemo(
    () =>
      collections.find(
        (collection) => collection.id === selectedCollectionId,
      ) || null,
    [collections, selectedCollectionId],
  );

  const members = useMemo(() => {
    if (!selectedCollectionId) return [];
    return connections.filter((connection) =>
      (connection.collectionIds || []).includes(selectedCollectionId),
    );
  }, [connections, selectedCollectionId]);

  const availableConnections = useMemo(() => {
    if (!selectedCollectionId) return [];
    return connections.filter(
      (connection) =>
        !(connection.collectionIds || []).includes(selectedCollectionId),
    );
  }, [connections, selectedCollectionId]);

  const memberIds = useMemo(
    () => members.map((connection) => connection.id),
    [members],
  );

  const selectedStatus = useMemo(
    () => getCollectionStatus(connections, selectedCollectionId),
    [connections, selectedCollectionId],
  );

  const isReservedCollection = selectedCollection?.name === "All Connections";

  useEffect(() => {
    if (editingCollectionId !== selectedCollectionId) {
      setEditingCollectionId(null);
    }
  }, [editingCollectionId, selectedCollectionId]);

  const updateMemberships = async (nextIds) => {
    if (!selectedCollection) return;
    setSavingMemberships(true);
    try {
      const response = await fetch(
        `/api/connection-collections/${selectedCollection.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionIds: nextIds }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to update collection");
      }
      await fetchData();
    } catch (error) {
      notify.error(error.message || "Failed to update collection");
    } finally {
      setSavingMemberships(false);
    }
  };

  const handleCreate = async () => {
    const name = newCollectionName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const response = await fetch("/api/connection-collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to create collection");
      }
      setShowCreateModal(false);
      setNewCollectionName("");
      await fetchData();
      setSelectedCollectionId(data.collection.id);
    } catch (error) {
      notify.error(error.message || "Failed to create collection");
    } finally {
      setCreating(false);
    }
  };

  const beginRename = (collection) => {
    setEditingCollectionId(collection.id);
    setRenameValue(collection.name);
    setActionMenuId(null);
  };

  const handleRename = async () => {
    if (!selectedCollection || isReservedCollection) return;
    const name = renameValue.trim();
    if (!name || name === selectedCollection.name) return;
    setRenaming(true);
    try {
      const response = await fetch(
        `/api/connection-collections/${selectedCollection.id}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to rename collection");
      }
      setEditingCollectionId(null);
      setRenameValue("");
      await fetchData();
    } catch (error) {
      notify.error(error.message || "Failed to rename collection");
    } finally {
      setRenaming(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedCollection || isReservedCollection) return;
    setDeleting(true);
    try {
      const response = await fetch(
        `/api/connection-collections/${selectedCollection.id}`,
        {
          method: "DELETE",
        },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to delete collection");
      }
      setShowDeleteModal(false);
      await fetchData();
    } catch (error) {
      notify.error(error.message || "Failed to delete collection");
    } finally {
      setDeleting(false);
    }
  };

  const handleRemoveConnection = async (connectionId) => {
    await updateMemberships(memberIds.filter((id) => id !== connectionId));
  };

  const handleAddConnections = async () => {
    if (pendingAddIds.length === 0) return;
    const nextIds = [...new Set([...memberIds, ...pendingAddIds])];
    await updateMemberships(nextIds);
    setPendingAddIds([]);
    setShowAddModal(false);
  };

  const handleCollectionStatusToggle = async (isActive) => {
    if (!selectedCollection || members.length === 0) return;
    setSavingCollectionStatus(true);
    try {
      const results = await Promise.all(
        members.map(async (connection) => {
          const response = await fetch(`/api/providers/${connection.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ isActive }),
          });
          const data = await response.json();
          if (!response.ok) {
            throw new Error(
              data?.error ||
                `Failed to update ${connection.name || "connection"}`,
            );
          }
          return data.connection;
        }),
      );

      const updatedById = new Map(
        results.map((connection) => [connection.id, connection]),
      );
      setConnections((current) =>
        current.map((connection) =>
          updatedById.has(connection.id)
            ? { ...connection, ...updatedById.get(connection.id), isActive }
            : connection,
        ),
      );
      await fetchData();
    } catch (error) {
      notify.error(error.message || "Failed to update collection status");
      await fetchData();
    } finally {
      setSavingCollectionStatus(false);
    }
  };

  if (loading) {
    return <CollectionsPageSkeleton />;
  }

  return (
    <>
      <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
        <Card
          title="Collections"
          subtitle={`${collections.length} collection${collections.length === 1 ? "" : "s"}`}
          icon="inventory_2"
          className="h-[calc(100vh-220px)] min-h-[560px]"
          action={
            <Button
              size="sm"
              variant="secondary"
              icon="add"
              onClick={() => setShowCreateModal(true)}
            />
          }
        >
          <div className="flex h-full flex-col gap-2 overflow-y-auto pr-1">
            {collections.map((collection) => {
              const isSelected = collection.id === selectedCollectionId;
              const isEditing = editingCollectionId === collection.id;
              const status = getCollectionStatus(connections, collection.id);
              const isReserved = collection.name === "All Connections";

              return (
                <div
                  key={collection.id}
                  className={`rounded-lg border ${
                    isSelected
                      ? "border-primary bg-primary/10"
                      : "border-black/5 bg-black/[0.02] dark:border-white/5 dark:bg-white/[0.02]"
                  }`}
                >
                  <div className="flex items-start gap-2 px-4 py-3">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedCollectionId(collection.id);
                        setActionMenuId(null);
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      {isEditing ? (
                        <div className="flex flex-col gap-2">
                          <Input
                            value={renameValue}
                            onChange={(event) =>
                              setRenameValue(event.target.value)
                            }
                            className="gap-0"
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleRename();
                              }}
                              loading={renaming}
                              disabled={
                                !renameValue.trim() ||
                                renameValue.trim() === collection.name
                              }
                            >
                              Save
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={(event) => {
                                event.stopPropagation();
                                setEditingCollectionId(null);
                                setRenameValue("");
                              }}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="font-medium text-text-main">
                            {collection.name}
                          </p>
                          <div className="mt-1 flex items-center gap-2 text-xs text-text-muted">
                            <span>{status.total} connection(s)</span>
                            <Badge
                              size="sm"
                              variant={status.isOn ? "success" : "default"}
                            >
                              {status.isOn ? "On" : "Off"}
                            </Badge>
                            {isReserved ? (
                              <Badge size="sm" variant="info">
                                Fallback
                              </Badge>
                            ) : null}
                          </div>
                        </>
                      )}
                    </button>

                    {!isReserved && !isEditing ? (
                      <div
                        className="relative"
                        ref={actionMenuId === collection.id ? menuRef : null}
                      >
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedCollectionId(collection.id);
                            setActionMenuId((current) =>
                              current === collection.id ? null : collection.id,
                            );
                          }}
                          className="rounded-md p-1 text-text-muted hover:bg-black/5 hover:text-text-main dark:hover:bg-white/5"
                        >
                          <span className="material-symbols-outlined text-[18px]">
                            more_horiz
                          </span>
                        </button>
                        {actionMenuId === collection.id ? (
                          <div className="absolute right-0 top-8 z-20 w-32 overflow-hidden rounded-lg border border-black/10 bg-surface shadow-xl dark:border-white/10">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                beginRename(collection);
                              }}
                              className="w-full px-3 py-2 text-left text-sm text-text-main hover:bg-black/5 dark:hover:bg-white/5"
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedCollectionId(collection.id);
                                setShowDeleteModal(true);
                                setActionMenuId(null);
                              }}
                              className="w-full px-3 py-2 text-left text-sm text-red-500 hover:bg-red-500/10"
                            >
                              Delete
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card
          title={selectedCollection?.name || "Connections"}
          subtitle={`${members.length} member${members.length === 1 ? "" : "s"}`}
          icon="dns"
          action={
            <div className="flex flex-wrap items-center justify-end gap-3">
              <span className="text-xs text-text-muted">
                {selectedStatus.active} active / {selectedStatus.disabled}{" "}
                disabled
              </span>
              <div className="flex items-center gap-2 text-xs font-medium text-text-muted">
                <span>{selectedStatus.isOn ? "On" : "Off"}</span>
                <Toggle
                  size="sm"
                  checked={selectedStatus.isOn}
                  onChange={handleCollectionStatusToggle}
                  disabled={
                    !selectedCollection ||
                    members.length === 0 ||
                    savingCollectionStatus
                  }
                />
              </div>
              <Button
                size="sm"
                icon="add"
                onClick={() => setShowAddModal(true)}
                disabled={
                  !selectedCollection ||
                  isReservedCollection ||
                  availableConnections.length === 0
                }
              >
                Add connection
              </Button>
            </div>
          }
        >
          {selectedCollection ? (
            members.length > 0 ? (
              <div className="flex flex-col gap-2">
                {members.map((connection) => (
                  <div
                    key={connection.id}
                    className="flex items-center justify-between gap-4 rounded-lg border border-black/5 bg-black/[0.02] px-4 py-3 dark:border-white/5 dark:bg-white/[0.02]"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-text-main">
                          {connection.name}
                        </p>
                        <Badge
                          size="sm"
                          variant={
                            connection.isActive === false
                              ? "default"
                              : "success"
                          }
                        >
                          {connection.isActive === false ? "Off" : "On"}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-text-muted">
                        {connection.provider}
                        {connection.email ? ` · ${connection.email}` : ""}
                      </p>
                    </div>
                    {!isReservedCollection ? (
                      <button
                        type="button"
                        onClick={() => handleRemoveConnection(connection.id)}
                        disabled={savingMemberships}
                        className="rounded-md p-2 text-text-muted hover:bg-red-500/10 hover:text-red-500 disabled:opacity-50"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          delete
                        </span>
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-black/10 px-4 py-8 text-center text-sm text-text-muted dark:border-white/10">
                No connections in this collection.
              </div>
            )
          ) : (
            <div className="rounded-lg border border-dashed border-black/10 px-4 py-8 text-center text-sm text-text-muted dark:border-white/10">
              Select a collection.
            </div>
          )}
        </Card>
      </div>

      <Modal
        isOpen={showCreateModal}
        onClose={() => {
          if (!creating) {
            setShowCreateModal(false);
            setNewCollectionName("");
          }
        }}
        title="Create collection"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setShowCreateModal(false);
                setNewCollectionName("");
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              loading={creating}
              disabled={!newCollectionName.trim()}
            >
              Create
            </Button>
          </>
        }
      >
        <Input
          label="Collection name"
          value={newCollectionName}
          onChange={(event) => setNewCollectionName(event.target.value)}
          placeholder="Image, Text, Overflow"
        />
      </Modal>

      <Modal
        isOpen={showAddModal}
        onClose={() => {
          if (!savingMemberships) {
            setShowAddModal(false);
            setPendingAddIds([]);
          }
        }}
        title="Add connection"
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setShowAddModal(false);
                setPendingAddIds([]);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAddConnections}
              loading={savingMemberships}
              disabled={pendingAddIds.length === 0}
            >
              Add
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          {availableConnections.length > 0 ? (
            availableConnections.map((connection) => {
              const checked = pendingAddIds.includes(connection.id);
              return (
                <label
                  key={connection.id}
                  className="flex items-center justify-between gap-4 rounded-lg border border-black/5 px-4 py-3 dark:border-white/5"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-text-main">
                      {connection.name}
                    </p>
                    <p className="mt-1 text-xs text-text-muted">
                      {connection.provider}
                      {connection.email ? ` · ${connection.email}` : ""}
                    </p>
                  </div>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      setPendingAddIds((current) =>
                        event.target.checked
                          ? [...current, connection.id]
                          : current.filter((id) => id !== connection.id),
                      );
                    }}
                    className="h-4 w-4 rounded border-black/20 text-primary focus:ring-primary/30"
                  />
                </label>
              );
            })
          ) : (
            <p className="text-sm text-text-muted">No available connections.</p>
          )}
        </div>
      </Modal>

      <Modal
        isOpen={showDeleteModal}
        onClose={() => {
          if (!deleting) setShowDeleteModal(false);
        }}
        title="Delete collection"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setShowDeleteModal(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} loading={deleting}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          Delete{" "}
          <span className="font-medium text-text-main">
            {selectedCollection?.name}
          </span>
          ?
        </p>
      </Modal>
    </>
  );
}
