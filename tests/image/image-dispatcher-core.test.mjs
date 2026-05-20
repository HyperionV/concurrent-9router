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
  const { clearImageDispatchTables } =
    await import("@/lib/sqlite/imageDispatcherStore.js");
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
  const { createImageDispatcherCore } =
    await import("@/lib/dispatcher/imageCore.js");

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
  const { createImageDispatcherCore } =
    await import("@/lib/dispatcher/imageCore.js");

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

test("image dispatcher allows multiple concurrent image slots per connection", async () => {
  await resetImageDispatcherTables();
  const { createImageDispatcherCore } =
    await import("@/lib/dispatcher/imageCore.js");

  const dispatcher = createImageDispatcherCore({
    getConnections: async () => makeConnections(1),
    getSlotsPerConnection: () => 2,
  });

  const first = await dispatcher.enqueueRequest({ modelId: "gpt-5.5-image" });
  const second = await dispatcher.enqueueRequest({ modelId: "gpt-5.5-image" });
  const third = await dispatcher.enqueueRequest({ modelId: "gpt-5.5-image" });

  const firstLease = await dispatcher.tryLeaseRequest(first.request.id);
  const secondLease = await dispatcher.tryLeaseRequest(second.request.id);
  const thirdLease = await dispatcher.tryLeaseRequest(third.request.id);
  const snapshot = await dispatcher.getStatusSnapshot();

  assert.equal(firstLease.connectionId, "conn-1");
  assert.equal(secondLease.connectionId, "conn-1");
  assert.equal(thirdLease, null);
  assert.deepEqual(dispatcher.getInMemorySnapshot().occupancyByConnection, {
    "conn-1": 2,
  });
  assert.equal(snapshot.capacity.capacityPerConnection, 2);
  assert.equal(snapshot.capacity.totalCapacity, 2);
  assert.equal(snapshot.capacity.activeLeases, 2);
  assert.equal(snapshot.capacity.availableLeases, 0);
});

test("image dispatcher status awaits async image slot settings", async () => {
  await resetImageDispatcherTables();
  const { createImageDispatcherCore } =
    await import("@/lib/dispatcher/imageCore.js");

  let slotsPerConnection = 3;
  const dispatcher = createImageDispatcherCore({
    getConnections: async () => makeConnections(2),
    getSlotsPerConnection: async () => slotsPerConnection,
  });

  const initialSnapshot = await dispatcher.getStatusSnapshot();
  assert.equal(initialSnapshot.capacity.capacityPerConnection, 3);
  assert.equal(initialSnapshot.capacity.totalCapacity, 6);

  slotsPerConnection = 2;
  const updatedSnapshot = await dispatcher.getStatusSnapshot();
  assert.equal(updatedSnapshot.capacity.capacityPerConnection, 2);
  assert.equal(updatedSnapshot.capacity.totalCapacity, 4);
});

test("image dispatcher serializes parallel lease attempts against connection capacity", async () => {
  await resetImageDispatcherTables();
  const { createImageDispatcherCore } =
    await import("@/lib/dispatcher/imageCore.js");

  const dispatcher = createImageDispatcherCore({
    getConnections: async () => makeConnections(1),
    getSlotsPerConnection: () => 2,
  });

  const queued = await Promise.all(
    Array.from({ length: 4 }, () =>
      dispatcher.enqueueRequest({ modelId: "gpt-5.5-image" }),
    ),
  );

  const leases = await Promise.all(
    queued.map(({ request }) => dispatcher.tryLeaseRequest(request.id)),
  );
  const leased = leases.filter(Boolean);

  assert.equal(leased.length, 2);
  assert.deepEqual(dispatcher.getInMemorySnapshot().occupancyByConnection, {
    "conn-1": 2,
  });
});

test("image dispatcher honors preferred connection only when its slot is free", async () => {
  await resetImageDispatcherTables();
  const { createImageDispatcherCore } =
    await import("@/lib/dispatcher/imageCore.js");

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

test("image dispatcher rotates separately completed requests across accounts", async () => {
  await resetImageDispatcherTables();
  const { createImageDispatcherCore } =
    await import("@/lib/dispatcher/imageCore.js");

  const dispatcher = createImageDispatcherCore({
    getConnections: async () => makeConnections(4),
  });

  const leasedConnectionIds = [];
  for (let index = 0; index < 12; index += 1) {
    const queued = await dispatcher.enqueueRequest({
      modelId: "gpt-5.5-image",
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
});

test("image dispatcher failure releases account occupancy", async () => {
  await resetImageDispatcherTables();
  const { createImageDispatcherCore } =
    await import("@/lib/dispatcher/imageCore.js");
  const { getImageDispatchAttempt } =
    await import("@/lib/sqlite/imageDispatcherStore.js");

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
