import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-sqlite-"));
}

test("settings persist requireApiKey and default codex policy", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();

  const { writeSettings, readSettings } = await import("@/lib/sqlite/store.js");
  writeSettings({
    requireApiKey: true,
    dispatcherEnabled: true,
    dispatcherShadowMode: false,
    codexDefaultAdmissionPolicy: "managed",
  });

  const settings = readSettings();
  assert.equal(settings.requireApiKey, true);
  assert.equal(settings.codexDefaultAdmissionPolicy, "managed");

  closeSqlite();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("settings normalize dispatcher collections and managed-only mode", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();

  const {
    readSettings,
    writeSettings,
    listConnectionCollections,
    listProviderConnections,
    createProviderConnectionRecord,
    createConnectionCollectionRecord,
    setConnectionCollectionsForConnection,
  } = await import("@/lib/sqlite/store.js");

  createProviderConnectionRecord({
    id: "conn-codex-1",
    provider: "codex",
    authType: "apikey",
    name: "Codex Primary",
    apiKey: "sk-test",
  });

  const collections = listConnectionCollections();
  assert.ok(collections.length >= 1);
  assert.equal(collections[0].name, "All Connections");

  const connections = listProviderConnections({ provider: "codex" });
  assert.equal(connections[0].collections?.[0]?.name, "All Connections");

  const textOnly = createConnectionCollectionRecord({ name: "Text Only" });
  setConnectionCollectionsForConnection("conn-codex-1", [
    collections[0].id,
    textOnly.id,
  ]);

  const filtered = listProviderConnections({
    provider: "codex",
    collectionId: textOnly.id,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, "conn-codex-1");

  writeSettings({
    dispatcherEnabled: false,
    dispatcherShadowMode: true,
    codexDefaultAdmissionPolicy: "legacy",
    textDispatcherCollectionId: collections[0].id,
    imageDispatcherCollectionId: collections[0].id,
  });

  const settings = readSettings();
  assert.equal(settings.dispatcherEnabled, true);
  assert.equal(settings.dispatcherShadowMode, false);
  assert.equal(settings.codexDefaultAdmissionPolicy, "managed");
  assert.equal(settings.textDispatcherCollectionId, collections[0].id);
  assert.equal(settings.imageDispatcherCollectionId, collections[0].id);

  closeSqlite();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("api keys persist codex admission override", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();

  const { createApiKeyRecord, getApiKeyByValue, updateApiKeyRecord } =
    await import("@/lib/sqlite/store.js");

  createApiKeyRecord({
    id: "key-1",
    name: "Prod Key",
    key: "sk-test-1",
    machineId: "machine-1",
    isActive: true,
    createdAt: new Date().toISOString(),
    codexAdmissionPolicyOverride: "managed",
  });

  let key = getApiKeyByValue("sk-test-1");
  assert.equal(key.codexAdmissionPolicyOverride, "managed");

  updateApiKeyRecord("key-1", {
    codexAdmissionPolicyOverride: "legacy",
  });

  key = getApiKeyByValue("sk-test-1");
  assert.equal(key.codexAdmissionPolicyOverride, "legacy");

  closeSqlite();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("deleting a collection unassigns members and resets dispatcher fallback", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();

  const {
    createConnectionCollectionRecord,
    createProviderConnectionRecord,
    deleteConnectionCollectionRecord,
    listConnectionCollections,
    listProviderConnections,
    replaceCollectionMemberships,
    readSettings,
    setConnectionCollectionsForConnection,
    writeSettings,
  } = await import("@/lib/sqlite/store.js");

  createProviderConnectionRecord({
    id: "conn-delete-test",
    provider: "codex",
    authType: "apikey",
    name: "Delete Test",
    apiKey: "sk-delete",
  });

  const allCollection = listConnectionCollections().find(
    (collection) => collection.name === "All Connections",
  );
  assert.ok(allCollection);

  const removable = createConnectionCollectionRecord({ name: "Removable" });
  setConnectionCollectionsForConnection("conn-delete-test", [removable.id]);
  writeSettings({
    textDispatcherCollectionId: removable.id,
    imageDispatcherCollectionId: removable.id,
  });

  const deleted = deleteConnectionCollectionRecord(removable.id);
  assert.equal(deleted.id, removable.id);

  const settings = readSettings();
  assert.equal(settings.textDispatcherCollectionId, allCollection.id);
  assert.equal(settings.imageDispatcherCollectionId, allCollection.id);

  const updatedConnection = listProviderConnections({
    provider: "codex",
  }).find((connection) => connection.id === "conn-delete-test");
  assert.deepEqual(updatedConnection.collectionIds, [allCollection.id]);

  assert.throws(
    () => replaceCollectionMemberships(allCollection.id, []),
    /cannot be edited/i,
  );

  closeSqlite();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
