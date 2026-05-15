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
