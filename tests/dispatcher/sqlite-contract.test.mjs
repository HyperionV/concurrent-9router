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
  
  // Verify default setting
  const initialSettings = readSettings();
  assert.equal(initialSettings.telegramEnabled, true);

  writeSettings({
    requireApiKey: true,
    dispatcherEnabled: true,
    dispatcherShadowMode: false,
    codexDefaultAdmissionPolicy: "managed",
    telegramEnabled: false,
  });

  const settings = readSettings();
  assert.equal(settings.requireApiKey, true);
  assert.equal(settings.codexDefaultAdmissionPolicy, "managed");
  assert.equal(settings.telegramEnabled, false);

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

test("telegram messaging settings guard", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();

  const { writeSettings } = await import("@/lib/sqlite/store.js");
  const { sendTelegramMessage } = await import("@/lib/telegram.js");

  // Save process env vars
  const origToken = process.env.TELEGRAM_BOT_TOKEN;
  const origChat = process.env.TELEGRAM_CHAT_ID;

  process.env.TELEGRAM_BOT_TOKEN = "123:test";
  process.env.TELEGRAM_CHAT_ID = "-456";

  writeSettings({ telegramEnabled: false });

  const resultDisabled = await sendTelegramMessage("test message");
  assert.equal(resultDisabled, false);

  // Restore env vars
  if (origToken) process.env.TELEGRAM_BOT_TOKEN = origToken;
  else delete process.env.TELEGRAM_BOT_TOKEN;

  if (origChat) process.env.TELEGRAM_CHAT_ID = origChat;
  else delete process.env.TELEGRAM_CHAT_ID;

  closeSqlite();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("periodic telegram report gate persists and skips scheduler", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite, getSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();

  const {
    readSettings,
    writeSettings,
    createProviderConnectionRecord,
  } = await import("@/lib/sqlite/store.js");
  const { maybeSendPeriodicReport } = await import("@/lib/telegram.js");

  // Default: periodic report is enabled
  const initial = readSettings();
  assert.equal(initial.telegramPeriodicReportEnabled, true);

  // Seed a connection so a real report would have content to send,
  // but disable periodic reports + telegram so no broadcast happens.
  createProviderConnectionRecord({
    id: "conn-1",
    provider: "codex",
    authType: "apikey",
    name: "Codex",
    apiKey: "sk-test",
  });

  // Disable BOTH toggles; periodic report should return false without
  // reaching the network.
  writeSettings({
    telegramEnabled: false,
    telegramPeriodicReportEnabled: false,
  });

  const skipped = await maybeSendPeriodicReport();
  assert.equal(skipped, false);

  // Re-enable periodic only (not all telegram) — periodic still gated
  // by the global telegramEnabled switch.
  writeSettings({ telegramEnabled: false, telegramPeriodicReportEnabled: true });
  const stillSkipped = await maybeSendPeriodicReport();
  assert.equal(stillSkipped, false);

  // Re-enable everything and confirm the row reflects the toggle.
  writeSettings({ telegramEnabled: true, telegramPeriodicReportEnabled: false });
  const reloaded = readSettings();
  assert.equal(reloaded.telegramEnabled, true);
  assert.equal(reloaded.telegramPeriodicReportEnabled, false);

  // Column is actually persisted (not just normalized in memory).
  const row = getSqlite()
    .prepare(
      "SELECT telegram_periodic_report_enabled FROM app_settings WHERE id = 1",
    )
    .get();
  assert.equal(row.telegram_periodic_report_enabled, 0);

  closeSqlite();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
