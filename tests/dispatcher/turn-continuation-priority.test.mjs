import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-dispatcher-priority-"));
}

test("turn continuation requests jump ahead of newer fresh turn-1 requests in queue", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  try {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    const { clearDispatchTables } = await import(
      "@/lib/sqlite/dispatcherStore.js"
    );
    clearDispatchTables();

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const connections = [
      { id: "conn-1", priority: 1, providerSpecificData: {} },
    ];

    const dispatcher = createDispatcherCore({
      provider: "grok-cli",
      getConnections: async () => connections,
      getSlotsPerConnection: () => 1,
    });

    // 1. Fill the single slot with an active request
    const qBlocking = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5-low",
    });
    const leaseBlocking = await dispatcher.tryLeaseRequest(qBlocking.request.id);
    assert.ok(leaseBlocking);

    // 2. Fresh Turn 1 request arrives at T0
    const qTurn1 = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      metadata: { isContinuation: false },
    });

    // 3. Multi-turn continuation request arrives at T1 (later than Turn 1)
    const qTurnContinuation = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      metadata: { isContinuation: true },
    });

    // Release the blocking slot
    await dispatcher.completeAttempt(leaseBlocking.attemptId);

    // Turn 1 tries to lease: should return null because Turn Continuation has higher priority
    const leaseTurn1 = await dispatcher.tryLeaseRequest(qTurn1.request.id);
    assert.equal(
      leaseTurn1,
      null,
      "turn 1 request should not steal the slot while turn continuation request is waiting",
    );

    // Turn continuation tries to lease: should succeed!
    const leaseContinuation = await dispatcher.tryLeaseRequest(qTurnContinuation.request.id);
    assert.ok(
      leaseContinuation,
      "turn continuation request should successfully lease ahead of queued turn 1 request",
    );
    assert.equal(leaseContinuation.requestId, qTurnContinuation.request.id);
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("anti-starvation ceiling promotes aged turn-1 requests ahead of continuation requests", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  try {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    const { clearDispatchTables } = await import(
      "@/lib/sqlite/dispatcherStore.js"
    );
    clearDispatchTables();

    const { sortRequestsByPriorityAndQueueTime } = await import(
      "@/lib/dispatcher/core.js"
    );

    const now = Date.now();
    const agedTurn1QueuedAt = new Date(now - 35000).toISOString(); // 35s ago (> 30s threshold)
    const freshTurn1QueuedAt = new Date(now - 5000).toISOString();  // 5s ago
    const continuationQueuedAt = new Date(now - 2000).toISOString(); // 2s ago

    const requests = [
      { id: "fresh-turn-1", queuedAt: freshTurn1QueuedAt, metadata: { isContinuation: false } },
      { id: "continuation", queuedAt: continuationQueuedAt, metadata: { isContinuation: true } },
      { id: "starved-turn-1", queuedAt: agedTurn1QueuedAt, metadata: { isContinuation: false } },
    ];

    const sorted = sortRequestsByPriorityAndQueueTime(requests, now);
    assert.equal(sorted[0].id, "starved-turn-1", "aged turn 1 request should be promoted to prevent starvation");
    assert.equal(sorted[1].id, "continuation", "continuation request should be second");
    assert.equal(sorted[2].id, "fresh-turn-1", "fresh unstarved turn 1 request should be last");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
