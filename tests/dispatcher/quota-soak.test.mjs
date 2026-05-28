import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-dispatcher-soak-"));
}

async function resetDispatcherTables(tempDir) {
  process.env.DATA_DIR = tempDir;
  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { clearDispatchTables } =
    await import("@/lib/sqlite/dispatcherStore.js");
  clearDispatchTables();
}

function makeConnections(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `conn-${index + 1}`,
    priority: index + 1,
    providerSpecificData: {},
  }));
}

class VirtualClock {
  constructor() {
    this.nowMs = 0;
    this.queue = [];
    this.sequence = 0;
  }

  now() {
    return this.nowMs;
  }

  at(delayMs, action) {
    this.queue.push({
      at: this.nowMs + delayMs,
      sequence: this.sequence,
      action,
    });
    this.sequence += 1;
    this.queue.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
  }

  async drain() {
    while (this.queue.length > 0) {
      const event = this.queue.shift();
      this.nowMs = event.at;
      await event.action();
    }
  }
}

test("concurrent lease polling cannot oversubscribe connection slots", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(1),
      getSlotsPerConnection: () => 1,
    });

    const queued = [];
    for (let index = 0; index < 20; index += 1) {
      queued.push(
        await dispatcher.enqueueRequest({
          modelId: "gpt-5-codex",
          requestKind: "race",
        }),
      );
    }

    const leases = await Promise.all(
      queued.map((entry) => dispatcher.tryLeaseRequest(entry.request.id)),
    );
    const leased = leases.filter(Boolean);

    assert.equal(
      leased.length,
      1,
      "only one request may claim the single slot",
    );
    assert.equal(
      dispatcher.getInMemorySnapshot().occupancyByConnection["conn-1"],
      1,
    );
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("quota reset blocks before reset and recovers after reset", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const { createDispatcherQuotaHealth } =
      await import("@/lib/dispatcher/quotaHealth.js");

    let nowMs = 0;
    const quotaHealth = createDispatcherQuotaHealth({
      now: () => nowMs,
      updateConnection: async () => {},
    });
    await quotaHealth.recordOutOfQuota({
      connectionId: "conn-1",
      modelId: "gpt-5-codex",
      resetsAtMs: 10_000,
      status: 429,
      error: "usage_limit_reached",
    });

    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(2),
      getSlotsPerConnection: () => 1,
      quotaHealth,
    });

    const beforeReset = await dispatcher.enqueueRequest({
      modelId: "gpt-5-codex",
      requestKind: "before-reset",
    });
    const beforeLease = await dispatcher.tryLeaseRequest(
      beforeReset.request.id,
    );
    assert.equal(beforeLease.connectionId, "conn-2");
    await dispatcher.completeAttempt(beforeLease.attemptId);

    nowMs = 9_999;
    const stillLimited = await dispatcher.enqueueRequest({
      modelId: "gpt-5-codex",
      requestKind: "still-limited",
    });
    const stillLimitedLease = await dispatcher.tryLeaseRequest(
      stillLimited.request.id,
    );
    assert.equal(stillLimitedLease.connectionId, "conn-2");
    await dispatcher.completeAttempt(stillLimitedLease.attemptId);

    nowMs = 10_001;
    const afterReset = await dispatcher.enqueueRequest({
      modelId: "gpt-5-codex",
      requestKind: "after-reset",
    });
    const afterLease = await dispatcher.tryLeaseRequest(afterReset.request.id);
    assert.equal(afterLease.connectionId, "conn-1");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("danger-zone quota is a soft penalty and uses remaining capacity", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const { createDispatcherQuotaHealth } =
      await import("@/lib/dispatcher/quotaHealth.js");
    const quotaHealth = createDispatcherQuotaHealth({
      updateConnection: async () => {},
    });
    await quotaHealth.recordQuotaSnapshot({
      connectionId: "conn-1",
      modelId: "gpt-5-codex",
      remainingFraction: 0.05,
    });

    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(2),
      getSlotsPerConnection: () => 1,
      quotaHealth,
    });

    const first = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
    const second = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });

    const firstLease = await dispatcher.tryLeaseRequest(first.request.id);
    const secondLease = await dispatcher.tryLeaseRequest(second.request.id);

    assert.equal(firstLease.connectionId, "conn-2");
    assert.equal(secondLease.connectionId, "conn-1");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("quota health is model-scoped and does not block unrelated models", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const { createDispatcherQuotaHealth } =
      await import("@/lib/dispatcher/quotaHealth.js");
    const quotaHealth = createDispatcherQuotaHealth({
      updateConnection: async () => {},
    });
    await quotaHealth.recordOutOfQuota({
      connectionId: "conn-1",
      modelId: "gpt-5-codex",
      resetsAtMs: Date.now() + 60_000,
      status: 429,
      error: "usage_limit_reached",
    });

    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(2),
      getSlotsPerConnection: () => 1,
      quotaHealth,
    });

    const unrelated = await dispatcher.enqueueRequest({ modelId: "gpt-4.1" });
    const unrelatedLease = await dispatcher.tryLeaseRequest(
      unrelated.request.id,
    );

    assert.equal(unrelatedLease.connectionId, "conn-1");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("persisted model lock blocks a connection without in-memory quota state", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const dispatcher = createDispatcherCore({
      getConnections: async () => [
        {
          id: "conn-1",
          priority: 1,
          providerSpecificData: {},
          "modelLock_gpt-5-codex": new Date(Date.now() + 60_000).toISOString(),
        },
        { id: "conn-2", priority: 2, providerSpecificData: {} },
      ],
      getSlotsPerConnection: () => 1,
    });

    const queued = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
    const lease = await dispatcher.tryLeaseRequest(queued.request.id);

    assert.equal(lease.connectionId, "conn-2");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("failed active attempt under load releases its slot for queued work", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const { listDispatchAttemptsByState } =
      await import("@/lib/sqlite/dispatcherStore.js");
    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(1),
      getSlotsPerConnection: () => 1,
    });

    const first = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
    const second = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
    const firstLease = await dispatcher.tryLeaseRequest(first.request.id);
    assert.ok(firstLease, "expected first request to lease");
    assert.equal(await dispatcher.tryLeaseRequest(second.request.id), null);

    await dispatcher.failAttempt(firstLease.attemptId, {
      terminalReason: "upstream_error",
      error: { status: 500, message: "server_error" },
    });

    const secondLease = await dispatcher.tryLeaseRequest(second.request.id);
    assert.ok(secondLease, "failed attempt should release capacity");
    assert.equal(secondLease.requestId, second.request.id);
    assert.equal(
      dispatcher.getInMemorySnapshot().occupancyByConnection["conn-1"],
      1,
    );

    const failed = listDispatchAttemptsByState(["failed"]);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].terminalReason, "upstream_error");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("quota failure under load avoids failed account on retry", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const { createDispatcherQuotaHealth } =
      await import("@/lib/dispatcher/quotaHealth.js");
    let nowMs = 100_000;
    const quotaHealth = createDispatcherQuotaHealth({
      now: () => nowMs,
      updateConnection: async () => {},
    });
    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(2),
      getSlotsPerConnection: () => 1,
      quotaHealth,
    });

    const failedRequest = await dispatcher.enqueueRequest({
      modelId: "gpt-5-codex",
      requestKind: "quota-failure",
    });
    const failedLease = await dispatcher.tryLeaseRequest(
      failedRequest.request.id,
    );
    assert.equal(failedLease.connectionId, "conn-1");

    await quotaHealth.recordOutOfQuota({
      connectionId: failedLease.connectionId,
      modelId: "gpt-5-codex",
      resetsAtMs: nowMs + 60_000,
      status: 429,
      error: "usage_limit_reached",
    });
    await dispatcher.failAttempt(failedLease.attemptId, {
      terminalReason: "fallback_requested",
      error: { status: 429, resetsAtMs: nowMs + 60_000 },
    });

    const retry = await dispatcher.enqueueRequest({
      modelId: "gpt-5-codex",
      requestKind: "quota-retry",
    });
    const retryLease = await dispatcher.tryLeaseRequest(retry.request.id);
    assert.ok(retryLease, "retry should find another account");
    assert.equal(retryLease.connectionId, "conn-2");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("one minute stream hang times out and releases capacity", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const { createDispatcherWatchdog } =
      await import("@/lib/dispatcher/watchdog.js");
    const { listDispatchAttemptsByState } =
      await import("@/lib/sqlite/dispatcherStore.js");
    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(1),
      getSlotsPerConnection: () => 1,
      timeoutPolicy: { idleTimeoutMs: 35_000 },
    });
    const watchdog = createDispatcherWatchdog({ dispatcher });

    const first = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
    const second = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
    const lease = await dispatcher.tryLeaseRequest(first.request.id);
    await dispatcher.markAttemptConnecting(lease.attemptId, {
      connectStartedAt: new Date(1_000).toISOString(),
    });
    await dispatcher.markAttemptStreamStarted(lease.attemptId, {
      streamStartedAt: new Date(1_000).toISOString(),
    });
    await dispatcher.markAttemptProgress(lease.attemptId, {
      at: new Date(1_000).toISOString(),
    });

    const sweep = await watchdog.runSweep(61_000);
    assert.equal(sweep.timedOut.length, 1);
    assert.equal(sweep.timedOut[0].timeoutKind, "idle_timeout");

    const timedOut = listDispatchAttemptsByState(["timed_out"]);
    assert.equal(timedOut.length, 1);
    assert.equal(timedOut[0].timeoutKind, "idle_timeout");

    const secondLease = await dispatcher.tryLeaseRequest(second.request.id);
    assert.ok(secondLease, "timed-out hung attempt should release the slot");
    assert.equal(secondLease.requestId, second.request.id);
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("dispatcher survives 5 accounts with 40 concurrent long-lived requests and periodic Codex arrivals", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const { createDispatcherQuotaHealth } =
      await import("@/lib/dispatcher/quotaHealth.js");
    const { listActiveDispatchAttempts, listDispatchAttemptsByState } =
      await import("@/lib/sqlite/dispatcherStore.js");

    const clock = new VirtualClock();
    const quotaHealth = createDispatcherQuotaHealth({
      now: () => clock.now(),
      updateConnection: async () => {},
    });
    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(5),
      getSlotsPerConnection: () => 8,
      quotaHealth,
    });

    const leased = [];
    const completed = [];
    const failedLeases = [];
    const occupancySamples = [];
    const leaseByRequest = new Map();
    const connectionLeaseCounts = new Map();

    async function leaseRequest({
      requestId,
      requestKind,
      holdMs,
      retryUntilMs = null,
    }) {
      const lease = await dispatcher.tryLeaseRequest(requestId);
      if (!lease) {
        if (retryUntilMs != null && clock.now() < retryUntilMs) {
          clock.at(1_000, async () => {
            await leaseRequest({
              requestId,
              requestKind,
              holdMs,
              retryUntilMs,
            });
          });
          return null;
        }
        failedLeases.push({ requestId, requestKind, at: clock.now() });
        return null;
      }

      if (leaseByRequest.has(requestId)) {
        throw new Error(`duplicate lease for request ${requestId}`);
      }
      leaseByRequest.set(requestId, lease);
      leased.push({ requestKind, at: clock.now(), ...lease });
      connectionLeaseCounts.set(
        lease.connectionId,
        (connectionLeaseCounts.get(lease.connectionId) || 0) + 1,
      );
      await dispatcher.markAttemptConnecting(lease.attemptId);
      await dispatcher.markAttemptStreamStarted(lease.attemptId);
      await dispatcher.markAttemptProgress(lease.attemptId, {
        at: new Date(clock.now()).toISOString(),
      });

      clock.at(holdMs, async () => {
        const completedAttempt = await dispatcher.completeAttempt(
          lease.attemptId,
        );
        if (completedAttempt) {
          completed.push({ requestKind, at: clock.now(), ...lease });
        }
      });
      return lease;
    }

    for (let index = 0; index < 40; index += 1) {
      const queued = await dispatcher.enqueueRequest({
        modelId: "gpt-5-codex",
        requestKind: "dispatcher-long-lived",
      });
      clock.at(0, async () => {
        await leaseRequest({
          requestId: queued.request.id,
          requestKind: "dispatcher-long-lived",
          holdMs: 180_000,
        });
      });
    }

    for (let tick = 0; tick <= 180_000; tick += 5_000) {
      clock.at(tick, async () => {
        for (let index = 0; index < 3; index += 1) {
          const queued = await dispatcher.enqueueRequest({
            modelId: "gpt-5-codex",
            requestKind: "codex-periodic",
          });
          await leaseRequest({
            requestId: queued.request.id,
            requestKind: "codex-periodic",
            holdMs: 5_000,
            retryUntilMs: clock.now() + 240_000,
          });
        }
      });
    }

    clock.at(60_000, async () => {
      await quotaHealth.recordQuotaSnapshot({
        connectionId: "conn-1",
        modelId: "gpt-5-codex",
        remainingFraction: 0.05,
      });
    });

    clock.at(175_000, async () => {
      await quotaHealth.recordOutOfQuota({
        connectionId: "conn-2",
        modelId: "gpt-5-codex",
        resetsAtMs: clock.now() + 30_000,
        status: 429,
        error: "usage_limit_reached",
      });
    });

    for (let tick = 0; tick <= 245_000; tick += 1_000) {
      clock.at(tick, async () => {
        const snapshot = dispatcher.getInMemorySnapshot();
        occupancySamples.push({ at: clock.now(), ...snapshot });
        for (const [connectionId, occupancy] of Object.entries(
          snapshot.occupancyByConnection,
        )) {
          assert.ok(
            occupancy <= 8,
            `${connectionId} exceeded slot limit with occupancy ${occupancy}`,
          );
          assert.ok(
            occupancy >= 0,
            `${connectionId} had negative occupancy ${occupancy}`,
          );
        }
      });
    }

    await clock.drain();

    const activeAttempts = listActiveDispatchAttempts("codex");
    const attempts = listDispatchAttemptsByState([
      "queued",
      "leased",
      "connecting",
      "streaming",
      "completed",
      "failed",
      "timed_out",
      "cancelled",
      "reconciled",
    ]).filter((attempt) => attempt.provider === "codex");
    const requestsByConnection = Object.fromEntries(connectionLeaseCounts);
    const periodicAfterLimit = leased.filter(
      (entry) =>
        entry.requestKind === "codex-periodic" &&
        entry.at >= 180_000 &&
        entry.at < 205_000,
    );

    assert.equal(failedLeases.length, 0, JSON.stringify(failedLeases, null, 2));
    assert.equal(
      activeAttempts.length,
      0,
      "all long-lived attempts should finish",
    );
    assert.equal(
      leased.length,
      151,
      "40 initial + 111 periodic requests should lease",
    );
    assert.equal(
      completed.length,
      leased.length,
      "every leased attempt should complete",
    );
    assert.equal(
      new Set(leased.map((entry) => entry.requestId)).size,
      leased.length,
      "each request should be leased exactly once",
    );
    assert.ok(
      periodicAfterLimit.every((entry) => entry.connectionId !== "conn-2"),
      "conn-2 should not receive gpt-5-codex leases while quota-limited",
    );
    assert.deepEqual(
      attempts
        .map((attempt) => attempt.state)
        .filter((state) => state !== "completed"),
      [],
      "all attempts should end completed",
    );
    assert.deepEqual(
      Object.keys(requestsByConnection).sort(),
      ["conn-1", "conn-2", "conn-3", "conn-4", "conn-5"],
      "load should use every configured connection",
    );
    assert.ok(
      occupancySamples.length >= 180,
      "simulation should sample occupancy across the full virtual runtime",
    );
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
