import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-dispatcher-core-"));
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

test("dispatcher avoids connections with active quota health limits", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const quotaHealth = {
      canServeRequest: (connection) => connection.id !== "conn-1",
      getSelectionPenalty: () => 0,
    };
    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(2),
      getSlotsPerConnection: () => 1,
      quotaHealth,
    });

    const queued = await dispatcher.enqueueRequest({
      modelId: "gpt-5-codex",
    });
    const lease = await dispatcher.tryLeaseRequest(queued.request.id);

    assert.ok(lease, "expected dispatcher to lease the request");
    assert.equal(lease.connectionId, "conn-2");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("dispatcher deprioritizes quota danger-zone connections", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const quotaHealth = {
      canServeRequest: () => true,
      getSelectionPenalty: (connection) =>
        connection.id === "conn-1" ? 1000 : 0,
    };
    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(2),
      getSlotsPerConnection: () => 1,
      quotaHealth,
    });

    const queued = await dispatcher.enqueueRequest({
      modelId: "gpt-5-codex",
    });
    const lease = await dispatcher.tryLeaseRequest(queued.request.id);

    assert.ok(lease, "expected dispatcher to lease the request");
    assert.equal(lease.connectionId, "conn-2");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("dispatcher deprioritizes real model-specific quota danger state", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const { createDispatcherQuotaHealth } =
      await import("@/lib/dispatcher/quotaHealth.js");
    const quotaHealth = createDispatcherQuotaHealth();
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

    const queued = await dispatcher.enqueueRequest({
      modelId: "gpt-5-codex",
    });
    const lease = await dispatcher.tryLeaseRequest(queued.request.id);

    assert.ok(lease, "expected dispatcher to lease the request");
    assert.equal(lease.connectionId, "conn-2");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("specific lease polling ignores unrelated queued request slot simulation", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(1),
      getSlotsPerConnection: () => 1,
    });

    await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
    const target = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
    const lease = await dispatcher.tryLeaseRequest(target.request.id);

    assert.ok(lease, "expected direct request polling to lease target request");
    assert.equal(lease.requestId, target.request.id);
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("text dispatcher rotates separately completed requests across accounts", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");

    const dispatcher = createDispatcherCore({
      getConnections: async () => makeConnections(4),
      getSlotsPerConnection: () => 20,
    });

    const leasedConnectionIds = [];
    for (let index = 0; index < 12; index += 1) {
      const queued = await dispatcher.enqueueRequest({
        modelId: "gpt-5-codex",
      });
      const lease = await dispatcher.tryLeaseRequest(queued.request.id);
      assert.ok(lease, `expected request ${queued.request.id} to lease`);
      leasedConnectionIds.push(lease.connectionId);
      await dispatcher.completeAttempt(lease.attemptId);
    }

    assert.deepEqual(leasedConnectionIds, [
      "conn-1",
      "conn-2",
      "conn-3",
      "conn-4",
      "conn-1",
      "conn-2",
      "conn-3",
      "conn-4",
      "conn-1",
      "conn-2",
      "conn-3",
      "conn-4",
    ]);
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
