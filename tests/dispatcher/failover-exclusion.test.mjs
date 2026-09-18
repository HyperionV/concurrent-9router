import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-dispatcher-failover-"));
}

test("requeued requests exclude failed connections and bypass stale affinity", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  try {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    const { clearDispatchTables, upsertDispatchConversationAffinity } =
      await import("@/lib/sqlite/dispatcherStore.js");
    clearDispatchTables();

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const connections = [
      { id: "conn-1", priority: 1, providerSpecificData: {} },
      { id: "conn-2", priority: 2, providerSpecificData: {} },
    ];

    const dispatcher = createDispatcherCore({
      provider: "grok-cli",
      getConnections: async () => connections,
      getSlotsPerConnection: () => 5,
    });

    // Seed affinity to conn-1 for a stateful conversation
    upsertDispatchConversationAffinity({
      conversationKey: "conv-stateful-1",
      apiKeyScope: "__no_key__",
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      connectionId: "conn-1",
      state: "active",
    });

    const q1 = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      conversationKey: "conv-stateful-1",
    });
    const lease1 = await dispatcher.tryLeaseRequest(q1.request.id);
    assert.equal(lease1.connectionId, "conn-1");

    // Fail attempt 1 and requeue with conn-1 excluded
    await dispatcher.failAttempt(lease1.attemptId, {
      nextState: "failed",
      terminalReason: "rate_limit_429",
    });

    const requeued = await dispatcher.requeueRequest(q1.request.id, {
      metadataPatch: {
        excludedConnectionIds: ["conn-1"],
      },
    });

    const lease2 = await dispatcher.tryLeaseRequest(requeued.request.id);
    assert.ok(
      lease2,
      "expected requeued request to lease to alternate connection",
    );
    assert.equal(
      lease2.connectionId,
      "conn-2",
      "expected failover to conn-2, bypassing conn-1",
    );
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
