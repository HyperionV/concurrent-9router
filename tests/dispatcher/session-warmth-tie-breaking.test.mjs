import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-dispatcher-warmth-"));
}

test("session warmth breaks ties between idle connections instead of cumulative leaseCount", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  try {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    const { clearDispatchTables, upsertDispatchConversationAffinity } = await import(
      "@/lib/sqlite/dispatcherStore.js"
    );
    clearDispatchTables();

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const connections = [
      { id: "conn-warm", priority: 1, providerSpecificData: {} },
      { id: "conn-cold", priority: 1, providerSpecificData: {} },
    ];

    const dispatcher = createDispatcherCore({
      provider: "grok-cli",
      getConnections: async () => connections,
      getSlotsPerConnection: () => 2,
    });

    // Seed session affinity to conn-warm
    upsertDispatchConversationAffinity({
      conversationKey: "pfx_agent_alpha",
      apiKeyScope: "__no_key__",
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      connectionId: "conn-warm",
      sessionId: "session-1",
      apiKeyId: null,
      state: "active",
    });

    // Simulate conn-warm having already served 1 turn on this conversation (leaseCount = 1)
    // while conn-cold has served 0 turns (leaseCount = 0).
    const q1 = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      conversationKey: "pfx_agent_alpha",
    });
    const lease1 = await dispatcher.tryLeaseRequest(q1.request.id);
    assert.ok(lease1);
    assert.equal(lease1.connectionId, "conn-warm");
    await dispatcher.completeAttempt(lease1.attemptId);

    // Now both conn-warm and conn-cold have 0 active occupancy.
    // However, conn-warm has leaseCount = 1, conn-cold has leaseCount = 0.
    // Turn 2 of pfx_agent_alpha arrives.
    const qTurn2 = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      conversationKey: "pfx_agent_alpha",
    });

    const leaseTurn2 = await dispatcher.tryLeaseRequest(qTurn2.request.id);
    assert.ok(leaseTurn2, "expected lease for turn 2");
    assert.equal(
      leaseTurn2.connectionId,
      "conn-warm",
      "expected session warmth to break tie and select conn-warm despite higher cumulative leaseCount",
    );
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("occupancyDiff strictly takes precedence over session warmth (fan-out safety invariant)", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  try {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    const { clearDispatchTables, upsertDispatchConversationAffinity } = await import(
      "@/lib/sqlite/dispatcherStore.js"
    );
    clearDispatchTables();

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const connections = [
      { id: "conn-busy-warm", priority: 1, providerSpecificData: {} },
      { id: "conn-idle-cold", priority: 1, providerSpecificData: {} },
    ];

    const dispatcher = createDispatcherCore({
      provider: "grok-cli",
      getConnections: async () => connections,
      getSlotsPerConnection: () => 2,
    });

    // Seed session affinity for sess_agent_beta to conn-busy-warm
    upsertDispatchConversationAffinity({
      conversationKey: "pfx_agent_beta",
      apiKeyScope: "__no_key__",
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      connectionId: "conn-busy-warm",
      sessionId: "session-2",
      apiKeyId: null,
      state: "active",
    });

    // Put 1 active in-flight request on conn-busy-warm
    const qBusy = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      conversationKey: "pfx_agent_beta",
    });
    const leaseBusy = await dispatcher.tryLeaseRequest(qBusy.request.id);
    assert.equal(leaseBusy.connectionId, "conn-busy-warm");

    // Now conn-busy-warm has occupancy = 1, conn-idle-cold has occupancy = 0.
    // A second request with the same prefix arrives.
    const qSpill = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      conversationKey: "pfx_agent_beta",
    });
    const leaseSpill = await dispatcher.tryLeaseRequest(qSpill.request.id);
    assert.ok(leaseSpill);
    assert.equal(
      leaseSpill.connectionId,
      "conn-idle-cold",
      "expected least-connections occupancyDiff to route to idle connection rather than bunching on warm connection",
    );
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
