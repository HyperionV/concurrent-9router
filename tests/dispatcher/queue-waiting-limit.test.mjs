/**
 * Queue waiting_limit: 5 minutes from queue arrival, continuous gate refill.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "9r-queue-wait-"));
}

async function resetDispatcherTables(tempDir) {
  process.env.DATA_DIR = tempDir;
  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { ensureSqliteReady } = await import("@/lib/sqlite/bootstrap.js");
  await ensureSqliteReady();
}

test("QUEUE_WAITING_LIMIT_MS is 5 minutes", async () => {
  const { QUEUE_WAITING_LIMIT_MS, DEFAULT_TIMEOUT_POLICY } = await import(
    "@/lib/dispatcher/timeoutPolicy.js"
  );
  assert.equal(QUEUE_WAITING_LIMIT_MS, 5 * 60 * 1000);
  assert.equal(DEFAULT_TIMEOUT_POLICY.waitingLimitMs, 5 * 60 * 1000);
  assert.equal(DEFAULT_TIMEOUT_POLICY.queueTtlMs, 5 * 60 * 1000);
});

test("remainingQueueWaitMs counts from queue arrival", async () => {
  const { remainingQueueWaitMs, QUEUE_WAITING_LIMIT_MS } = await import(
    "@/lib/dispatcher/timeoutPolicy.js"
  );
  const now = Date.now();
  const entered = new Date(now - 60_000).toISOString(); // 1 min ago
  const remaining = remainingQueueWaitMs(entered, {}, now);
  assert.ok(remaining <= QUEUE_WAITING_LIMIT_MS - 59_000);
  assert.ok(remaining >= QUEUE_WAITING_LIMIT_MS - 61_000);

  const expired = remainingQueueWaitMs(
    new Date(now - QUEUE_WAITING_LIMIT_MS - 1000).toISOString(),
    {},
    now,
  );
  assert.equal(expired, 0);
});

test("poll tryLeaseRequest returns null while slot is held", async () => {
  const tempDir = makeTempDataDir();
  try {
    await resetDispatcherTables(tempDir);
    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");

    const dispatcher = createDispatcherCore({
      provider: "grok-cli",
      getConnections: async () => [
        { id: "conn-1", priority: 1, providerSpecificData: {} },
      ],
      getSlotsPerConnection: () => 1,
    });

    const blocker = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5",
    });
    const blockLease = await dispatcher.tryLeaseRequest(blocker.request.id);
    assert.ok(blockLease);

    const queued = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5",
    });
    assert.equal(
      await dispatcher.tryLeaseRequest(queued.request.id),
      null,
      "must not lease while slot held",
    );

    await dispatcher.completeAttempt(blockLease.attemptId);
    assert.ok(await dispatcher.tryLeaseRequest(queued.request.id));
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
