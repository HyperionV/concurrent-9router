import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-dispatcher-pfx-"));
}

test("prefix-cache keys allow concurrent requests to spill across idle connections", async () => {
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
      { id: "conn-2", priority: 2, providerSpecificData: {} },
    ];

    const dispatcher = createDispatcherCore({
      provider: "grok-cli",
      getConnections: async () => connections,
      getSlotsPerConnection: () => 5,
    });

    const q1 = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      conversationKey: "pfx_test123",
    });
    const lease1 = await dispatcher.tryLeaseRequest(q1.request.id);
    assert.ok(lease1, "expected lease for first request");
    assert.equal(lease1.connectionId, "conn-1");

    // Second concurrent request with same prefix key while conn-1 is active
    const q2 = await dispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5-low",
      conversationKey: "pfx_test123",
    });
    const lease2 = await dispatcher.tryLeaseRequest(q2.request.id);
    assert.ok(
      lease2,
      "expected lease for second request instead of being blocked",
    );
    assert.equal(
      lease2.connectionId,
      "conn-2",
      "expected spillover to idle conn-2",
    );
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
