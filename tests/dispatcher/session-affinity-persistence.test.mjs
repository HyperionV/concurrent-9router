import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-dispatcher-persist-"));
}

test("successful turn completion persists conversationKey to dispatcher affinity", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  try {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    const { clearDispatchTables, getDispatchConversationAffinity } = await import(
      "@/lib/sqlite/dispatcherStore.js"
    );
    clearDispatchTables();

    const { persistConversationAffinity } = await import(
      "@/lib/dispatcher/conversationAffinity.js"
    );

    // Verify helper contract
    const sessionKey = "agent_session_uuid_999";
    const record = persistConversationAffinity({
      conversationKey: sessionKey,
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      connectionId: "conn-active-1",
      sessionId: "sub2api_sess_1",
      apiKeyId: null,
      state: "active",
    });

    assert.ok(record);
    const lookup = getDispatchConversationAffinity(sessionKey, "__no_key__");
    assert.ok(lookup);
    assert.equal(lookup.connectionId, "conn-active-1");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
