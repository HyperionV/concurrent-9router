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
