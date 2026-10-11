import test from "node:test";
import assert from "node:assert/strict";

async function freshDispatcher(connections) {
  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { clearDispatchTables, upsertDispatchConversationAffinity } =
    await import("@/lib/sqlite/dispatcherStore.js");
  clearDispatchTables();
  const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
  const dispatcher = createDispatcherCore({
    provider: "codex",
    getConnections: async () => connections,
    getSlotsPerConnection: () => 1,
  });
  return { dispatcher, upsertDispatchConversationAffinity };
}

test("a conversation pinned to an account that cannot serve moves to an idle account", async () => {
  const lockedUntil = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
  const connections = [
    {
      id: "conn_pinned",
      priority: 1,
      providerSpecificData: {},
      // Usage limit hit: this model is locked on the pinned account for hours.
      "modelLock_gpt-5-codex": lockedUntil,
    },
    { id: "conn_idle", priority: 2, providerSpecificData: {} },
  ];
  const { dispatcher, upsertDispatchConversationAffinity } =
    await freshDispatcher(connections);

  upsertDispatchConversationAffinity({
    conversationKey: "session-123",
    apiKeyScope: "__no_key__",
    provider: "codex",
    modelId: "gpt-5-codex",
    connectionId: "conn_pinned",
    state: "active",
  });

  const queued = await dispatcher.enqueueRequest({
    provider: "codex",
    modelId: "gpt-5-codex",
    conversationKey: "session-123",
  });
  const lease = await dispatcher.tryLeaseRequest(queued.request.id);

  assert.ok(lease, "must not strand the conversation on the locked account");
  assert.equal(lease.connectionId, "conn_idle");
});

test("a conversation pinned to a busy but healthy account waits for it", async () => {
  const connections = [
    { id: "conn_pinned", priority: 1, providerSpecificData: {} },
    { id: "conn_idle", priority: 2, providerSpecificData: {} },
  ];
  const { dispatcher, upsertDispatchConversationAffinity } =
    await freshDispatcher(connections);

  upsertDispatchConversationAffinity({
    conversationKey: "session-456",
    apiKeyScope: "__no_key__",
    provider: "codex",
    modelId: "gpt-5-codex",
    connectionId: "conn_pinned",
    state: "active",
  });

  const other = await dispatcher.enqueueRequest({ provider: "codex", modelId: "gpt-5-codex" });
  const otherLease = await dispatcher.tryLeaseRequest(other.request.id);
  assert.equal(otherLease.connectionId, "conn_pinned");

  const queued = await dispatcher.enqueueRequest({
    provider: "codex",
    modelId: "gpt-5-codex",
    conversationKey: "session-456",
  });
  assert.equal(await dispatcher.tryLeaseRequest(queued.request.id), null);
});

test("two simultaneous turns of one conversation never run on different accounts", async () => {
  const connections = [
    { id: "conn_a", priority: 1, providerSpecificData: {} },
    { id: "conn_b", priority: 2, providerSpecificData: {} },
  ];
  const { dispatcher } = await freshDispatcher(connections);

  const first = await dispatcher.enqueueRequest({
    provider: "codex",
    modelId: "gpt-5-codex",
    conversationKey: "session-789",
  });
  const second = await dispatcher.enqueueRequest({
    provider: "codex",
    modelId: "gpt-5-codex",
    conversationKey: "session-789",
  });

  const [leaseA, leaseB] = await Promise.all([
    dispatcher.tryLeaseRequest(first.request.id),
    dispatcher.tryLeaseRequest(second.request.id),
  ]);
  const leased = [leaseA, leaseB].filter(Boolean);

  assert.equal(leased.length, 1, "the second turn must wait for the first");
});
