import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-core-"));
process.env.DATA_DIR = tempRoot;

const runtime = await import("../../src/lib/sqlite/runtime.js");
const store = await import("../../src/lib/sqlite/dispatcherStore.js");
const { createDispatcherCore } =
  await import("../../src/lib/dispatcher/core.js");

function makeConnection(id, priority = 1) {
  return {
    id,
    provider: "codex",
    priority,
    connectionName: id,
    providerSpecificData: {},
  };
}

test("dispatcher refills free slots from central queue", async () => {
  runtime.getSqlite();
  store.clearDispatchTables();

  const dispatcher = createDispatcherCore({
    provider: "codex",
    getConnections: async () => [
      makeConnection("a", 1),
      makeConnection("b", 2),
    ],
    slotsPerConnection: 2,
  });

  const queued = [];
  for (let i = 1; i <= 5; i++) {
    queued.push(
      await dispatcher.enqueueRequest({
        id: `req-${i}`,
        provider: "codex",
        modelId: "gpt-5.3-codex",
      }),
    );
  }

  const firstWave = await dispatcher.tryLeaseAvailableWork();
  assert.equal(firstWave.length, 4);

  const perConnection = firstWave.reduce((acc, lease) => {
    acc[lease.connectionId] = (acc[lease.connectionId] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(perConnection, { a: 2, b: 2 });

  await dispatcher.completeAttempt(firstWave[0].attemptId, {
    terminalReason: "success",
  });

  const refill = await dispatcher.tryLeaseAvailableWork();
  assert.equal(refill.length, 1);
  assert.equal(
    dispatcher.getInMemorySnapshot().occupancyByConnection[
      refill[0].connectionId
    ],
    2,
  );
});

test("conversation-pinned request does not hop accounts when another slot is free", async () => {
  runtime.getSqlite();
  store.clearDispatchTables();

  store.upsertDispatchConversationAffinity({
    conversationKey: "conv-1",
    provider: "codex",
    modelId: "gpt-5.3-codex",
    connectionId: "a",
    sessionId: "sess-a",
  });

  const dispatcher = createDispatcherCore({
    provider: "codex",
    getConnections: async () => [
      makeConnection("a", 1),
      makeConnection("b", 2),
    ],
    slotsPerConnection: 1,
  });

  const pinned = await dispatcher.enqueueRequest({
    id: "req-pinned",
    provider: "codex",
    modelId: "gpt-5.3-codex",
    conversationKey: "conv-1",
  });
  const free = await dispatcher.enqueueRequest({
    id: "req-free",
    provider: "codex",
    modelId: "gpt-5.3-codex",
  });
  const later = await dispatcher.enqueueRequest({
    id: "req-later",
    provider: "codex",
    modelId: "gpt-5.3-codex",
    conversationKey: "conv-1",
  });

  const firstWave = await dispatcher.tryLeaseAvailableWork();
  assert.equal(firstWave.length, 2);

  const pinnedLease = firstWave.find(
    (item) => item.requestId === pinned.request.id,
  );
  const freeLease = firstWave.find(
    (item) => item.requestId === free.request.id,
  );

  assert.equal(pinnedLease.connectionId, "a");
  assert.equal(freeLease.connectionId, "b");

  const blocked = await dispatcher.tryLeaseAvailableWork();
  assert.equal(blocked.length, 0);

  await dispatcher.completeAttempt(freeLease.attemptId, {
    terminalReason: "success",
  });

  const stillBlocked = await dispatcher.tryLeaseAvailableWork();
  assert.equal(stillBlocked.length, 0);

  await dispatcher.completeAttempt(pinnedLease.attemptId, {
    terminalReason: "success",
  });

  const resumed = await dispatcher.tryLeaseAvailableWork();
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].requestId, later.request.id);
  assert.equal(resumed[0].connectionId, "a");
});
