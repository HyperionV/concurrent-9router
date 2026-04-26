import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-image-dispatcher-"));
}

const tempDir = makeTempDataDir();
process.env.DATA_DIR = tempDir;

async function resetImageDispatcherTables() {
  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { clearImageDispatchTables } = await import(
    "@/lib/sqlite/imageDispatcherStore.js"
  );
  clearImageDispatchTables();
}

process.on("exit", () => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "EBUSY") throw error;
  }
});

function makeConnections(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `conn-${index + 1}`,
    priority: index + 1,
    providerSpecificData: {},
  }));
}

test("image dispatcher keeps a second image queued while one account is occupied", async () => {
  await resetImageDispatcherTables();
  const { createImageDispatcherCore } = await import(
    "@/lib/dispatcher/imageCore.js"
  );

  const dispatcher = createImageDispatcherCore({
    getConnections: async () => makeConnections(1),
  });

  const first = await dispatcher.enqueueRequest({
    modelId: "gpt-5.5-image",
  });
  const second = await dispatcher.enqueueRequest({
    modelId: "gpt-5.5-image",
  });

  const firstLease = await dispatcher.tryLeaseRequest(first.request.id);
  const secondLease = await dispatcher.tryLeaseRequest(second.request.id);

  assert.equal(firstLease.connectionId, "conn-1");
  assert.equal(secondLease, null);
  assert.deepEqual(dispatcher.getInMemorySnapshot().occupancyByConnection, {
    "conn-1": 1,
  });

  await dispatcher.completeAttempt(firstLease.attemptId);

  const secondLeaseAfterRelease = await dispatcher.tryLeaseRequest(
    second.request.id,
  );
  assert.equal(secondLeaseAfterRelease.connectionId, "conn-1");
});

test("image dispatcher leases two image requests across two accounts", async () => {
  await resetImageDispatcherTables();
  const { createImageDispatcherCore } = await import(
    "@/lib/dispatcher/imageCore.js"
  );

  const dispatcher = createImageDispatcherCore({
    getConnections: async () => makeConnections(2),
  });

  const first = await dispatcher.enqueueRequest({
    modelId: "gpt-5.5-image",
  });
  const second = await dispatcher.enqueueRequest({
    modelId: "gpt-5.5-image",
  });

  const firstLease = await dispatcher.tryLeaseRequest(first.request.id);
  const secondLease = await dispatcher.tryLeaseRequest(second.request.id);

  assert.notEqual(firstLease.connectionId, secondLease.connectionId);
  assert.deepEqual(dispatcher.getInMemorySnapshot().occupancyByConnection, {
    "conn-1": 1,
    "conn-2": 1,
  });
});

test("image dispatcher honors preferred connection only when its slot is free", async () => {
  await resetImageDispatcherTables();
  const { createImageDispatcherCore } = await import(
    "@/lib/dispatcher/imageCore.js"
  );

  const dispatcher = createImageDispatcherCore({
    getConnections: async () => makeConnections(2),
  });

  const first = await dispatcher.enqueueRequest({
    modelId: "gpt-5.5-image",
    metadata: { preferredConnectionId: "conn-2" },
  });
  const second = await dispatcher.enqueueRequest({
    modelId: "gpt-5.5-image",
    metadata: { preferredConnectionId: "conn-2" },
  });

  const firstLease = await dispatcher.tryLeaseRequest(first.request.id);
  const secondLease = await dispatcher.tryLeaseRequest(second.request.id);

  assert.equal(firstLease.connectionId, "conn-2");
  assert.equal(secondLease.connectionId, "conn-1");
});

test("image dispatcher failure releases account occupancy", async () => {
  await resetImageDispatcherTables();
  const { createImageDispatcherCore } = await import(
    "@/lib/dispatcher/imageCore.js"
  );
  const { getImageDispatchAttempt } = await import(
    "@/lib/sqlite/imageDispatcherStore.js"
  );

  const dispatcher = createImageDispatcherCore({
    getConnections: async () => makeConnections(1),
  });

  const queued = await dispatcher.enqueueRequest({
    modelId: "gpt-5.5-image",
  });
  const lease = await dispatcher.tryLeaseRequest(queued.request.id);

  await dispatcher.failAttempt(lease.attemptId, {
    terminalReason: "upstream_error",
    error: { status: 400 },
  });

  const attempt = getImageDispatchAttempt(lease.attemptId);
  assert.equal(attempt.state, "failed");
  assert.equal(attempt.terminalReason, "upstream_error");
  assert.deepEqual(dispatcher.getInMemorySnapshot().occupancyByConnection, {
    "conn-1": 0,
  });
});
