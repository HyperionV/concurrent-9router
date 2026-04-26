import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-dispatcher-"));
}

test("managed affinity is scoped to the same api key lineage", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();

  const { clearDispatchTables, getDispatchConversationAffinity } =
    await import("@/lib/sqlite/dispatcherStore.js");
  const { getConversationAffinity, persistConversationAffinity } =
    await import("@/lib/dispatcher/conversationAffinity.js");

  clearDispatchTables();

  persistConversationAffinity({
    conversationKey: "resp_123",
    provider: "codex",
    modelId: "gpt-5-codex",
    connectionId: "conn-a",
    sessionId: "sess-a",
    apiKeyId: "key-a",
  });

  const raw = getDispatchConversationAffinity("resp_123", "key-a");
  assert.equal(raw.apiKeyId, "key-a");

  const matched = getConversationAffinity("resp_123", "key-a");
  assert.equal(matched.connectionId, "conn-a");

  const mismatched = getConversationAffinity("resp_123", "key-b");
  assert.equal(mismatched, null);

  closeSqlite();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("shadow traffic does not seed managed affinity", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();

  const { clearDispatchTables, getDispatchConversationAffinity } =
    await import("@/lib/sqlite/dispatcherStore.js");
  const { beginShadowCodexAttempt } =
    await import("@/lib/dispatcher/shadowMode.js");

  clearDispatchTables();

  const tracker = beginShadowCodexAttempt({
    provider: "codex",
    modelId: "gpt-5-codex",
    routeModel: "codex/gpt-5-codex",
    connectionId: "conn-shadow",
    apiKeyId: "key-shadow",
  });

  await tracker.dispatcherHooks.onResponseIdentity("resp_shadow");

  const affinity = getDispatchConversationAffinity("resp_shadow", "key-shadow");
  assert.equal(affinity, null);

  closeSqlite();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
