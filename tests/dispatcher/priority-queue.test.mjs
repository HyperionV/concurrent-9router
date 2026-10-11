import test from "node:test";
import assert from "node:assert/strict";

// Who gets a freed slot. Real dispatcher core on the test's SQLite database;
// accounts are plain connection records.

async function freshDispatcher(connectionIds, connectionExtras = {}) {
  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { clearDispatchTables } = await import("@/lib/sqlite/dispatcherStore.js");
  clearDispatchTables();
  globalThis.__dispatcherWaiterSeenAt?.clear();
  const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
  const connections = connectionIds.map((id, index) => ({
    id,
    priority: index + 1,
    providerSpecificData: {},
    ...connectionExtras,
  }));
  const dispatcher = createDispatcherCore({
    provider: "codex",
    getConnections: async () => connections,
    getSlotsPerConnection: () => 1,
  });

  const enqueue = (priorityClass, modelId = "gpt-5-codex", metadata = {}) =>
    dispatcher
      .enqueueRequest({ provider: "codex", modelId, metadata: { priorityClass, ...metadata } })
      .then(({ request }) => request.id);
  // Every waiter polls once, as its client's lease loop would.
  const pollAll = async (requestIds) => {
    const leases = {};
    for (const id of requestIds) leases[id] = await dispatcher.tryLeaseRequest(id);
    return leases;
  };
  return { dispatcher, enqueue, pollAll };
}

test("a freed slot goes to the waiting interactive request ahead of earlier batch work", async () => {
  const { dispatcher, enqueue, pollAll } = await freshDispatcher(["conn_a", "conn_b"]);
  const running = [await enqueue("batch"), await enqueue("batch")];
  const runningLeases = await pollAll(running);

  const waitingBatch = [await enqueue("batch"), await enqueue("batch"), await enqueue("batch")];
  const interactive = await enqueue("interactive");
  await pollAll([...waitingBatch, interactive]);

  await dispatcher.completeAttempt(runningLeases[running[0]].attemptId);
  // Batch requests that arrived first poll first and still must step aside.
  const afterFree = await pollAll([...waitingBatch, interactive]);

  assert.ok(afterFree[interactive], "the interactive request gets the freed slot");
  assert.ok(waitingBatch.every((id) => !afterFree[id]), "no batch request jumps ahead");
});

test("batch work stops at its share of slots while interactive work still gets an idle one", async () => {
  // 5 slots, batch share 0.8: batch may hold 4.
  const { enqueue, pollAll } = await freshDispatcher(["c1", "c2", "c3", "c4", "c5"]);
  const batch = [];
  for (let i = 0; i < 4; i++) batch.push(await enqueue("batch"));
  const leases = await pollAll(batch);
  assert.ok(batch.every((id) => leases[id]), "four batch requests run");

  const fifthBatch = await enqueue("batch");
  assert.equal((await pollAll([fifthBatch]))[fifthBatch], null, "the fifth batch request waits");

  const interactive = await enqueue("interactive");
  assert.ok((await pollAll([interactive]))[interactive], "interactive takes the idle slot");
});

test("an interactive request that cannot run anywhere does not hold back batch work", async () => {
  const lockedUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // Every account is locked for the model the interactive request wants.
  const { enqueue, pollAll } = await freshDispatcher(["conn_a", "conn_b"], {
    "modelLock_gpt-5-pro": lockedUntil,
  });
  // A continuation turn: it ranks above fresh batch work on every rule.
  const stuckInteractive = await enqueue("interactive", "gpt-5-pro", { isContinuation: true });
  const batch = await enqueue("batch", "gpt-5-codex");

  const leases = await pollAll([stuckInteractive, batch]);

  assert.equal(leases[stuckInteractive], null);
  assert.ok(leases[batch], "batch runs on the free account");
});

test("a request with no priority header is batch, and the header value interactive is the only way up", async () => {
  const { priorityClassFromHeader } = await import("@/lib/dispatcher/priorityQueue.js");

  assert.equal(priorityClassFromHeader(null), "batch");
  assert.equal(priorityClassFromHeader("urgent"), "batch");
  assert.equal(priorityClassFromHeader(" Interactive "), "interactive");
});

test("under a burst of batch work every request completes, and only the Manager's request is recorded as interactive", { timeout: 30_000 }, async () => {
  const { withManagedCodex, jsonResponse, sleep } = await import("./managed-codex-harness.mjs");
  const { getDispatchRequest } = await import("@/lib/sqlite/dispatcherStore.js");

  await withManagedCodex(
    ["conn_burst_a", "conn_burst_b"],
    async () => {
      await sleep(100);
      return jsonResponse(200, { id: "resp_ok", object: "response", status: "completed", output: [] });
    },
    async ({ send, listAttempts }) => {
      const batch = Array.from({ length: 12 }, () => send());
      await sleep(50);
      const manager = send({ headers: { "x-brae-priority": "interactive" } });

      const statuses = (await Promise.all([...batch, manager])).map((response) => response.status);

      assert.ok(statuses.every((status) => status === 200), `none rejected or failed: ${statuses}`);
      const classes = [...new Set(listAttempts().map((attempt) => attempt.requestId))].map(
        (requestId) => getDispatchRequest(requestId).metadata.priorityClass,
      );
      assert.equal(classes.filter((value) => value === "interactive").length, 1);
      assert.equal(classes.filter((value) => value === "batch").length, 12);
    },
  );
});
