import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-store-"));
process.env.DATA_DIR = tempRoot;

const runtime = await import("../../src/lib/sqlite/runtime.js");
const store = await import("../../src/lib/sqlite/dispatcherStore.js");

test("dispatcher store persists requests attempts events and affinity", () => {
  runtime.getSqlite();
  store.clearDispatchTables();

  const request = store.insertDispatchRequest({
    id: "req-1",
    provider: "codex",
    modelId: "gpt-5.3-codex",
    conversationKey: "conv-1",
    status: "queued",
    metadata: { endpoint: "/v1/responses" },
  });

  assert.equal(request.id, "req-1");
  assert.equal(request.status, "queued");
  assert.equal(request.metadata.endpoint, "/v1/responses");

  store.insertDispatchAttempt({
    id: "att-1",
    requestId: "req-1",
    attemptIndex: 0,
    provider: "codex",
    modelId: "gpt-5.3-codex",
    state: "queued",
  });

  const leased = store.leaseDispatchAttempt("att-1", {
    connectionId: "conn-1",
    leaseKey: "lease-1",
    pathMode: "connection-proxy",
  });

  assert.equal(leased.connectionId, "conn-1");
  assert.equal(leased.state, "leased");
  assert.equal(leased.pathMode, "connection-proxy");

  const connecting = store.transitionDispatchAttempt(
    "att-1",
    "leased",
    "connecting",
    {
      connectStartedAt: "2026-04-20T00:00:01.000Z",
    },
  );
  assert.equal(connecting.state, "connecting");
  assert.equal(connecting.connectStartedAt, "2026-04-20T00:00:01.000Z");

  const completed = store.transitionDispatchAttempt(
    "att-1",
    ["connecting", "streaming"],
    "completed",
    {
      finishedAt: "2026-04-20T00:00:10.000Z",
      terminalReason: "success",
      error: { ignored: true },
    },
  );

  assert.equal(completed.state, "completed");
  assert.equal(completed.finishedAt, "2026-04-20T00:00:10.000Z");
  assert.equal(completed.terminalReason, "success");
  assert.deepEqual(completed.error, { ignored: true });

  store.insertDispatchAttemptEvent({
    id: "evt-1",
    attemptId: "att-1",
    eventType: "stream_started",
    payload: { providerStatus: 200 },
  });

  const events = store.listDispatchAttemptEvents("att-1");
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "stream_started");
  assert.equal(events[0].payload.providerStatus, 200);

  const affinity = store.upsertDispatchConversationAffinity({
    conversationKey: "conv-1",
    provider: "codex",
    modelId: "gpt-5.3-codex",
    connectionId: "conn-1",
    sessionId: "sess-1",
  });

  assert.equal(affinity.connectionId, "conn-1");
  assert.equal(
    store.getDispatchConversationAffinity("conv-1").sessionId,
    "sess-1",
  );
});

test("dispatcher attempt transition honors compare-and-set state guards", () => {
  runtime.getSqlite();
  store.clearDispatchTables();

  store.insertDispatchRequest({
    id: "req-2",
    provider: "codex",
    modelId: "gpt-5.3-codex",
  });
  store.insertDispatchAttempt({
    id: "att-2",
    requestId: "req-2",
    attemptIndex: 0,
    provider: "codex",
    modelId: "gpt-5.3-codex",
    state: "queued",
  });

  const blocked = store.transitionDispatchAttempt(
    "att-2",
    "leased",
    "completed",
    { finishedAt: "2026-04-20T00:01:00.000Z" },
  );
  assert.equal(blocked, null);

  const lease = store.leaseDispatchAttempt("att-2", {
    connectionId: "conn-2",
    leaseKey: "lease-2",
  });
  assert.equal(lease.state, "leased");

  const wrongLease = store.leaseDispatchAttempt("att-2", {
    connectionId: "conn-3",
    leaseKey: "lease-3",
  });
  assert.equal(wrongLease, null);
});

test("conversation affinity upsert replaces continuation key while preserving connection pin", () => {
  runtime.getSqlite();
  store.clearDispatchTables();

  store.upsertDispatchConversationAffinity({
    conversationKey: "resp-old",
    provider: "codex",
    modelId: "gpt-5.3-codex",
    connectionId: "conn-12",
    sessionId: "sess-12",
  });

  const updated = store.upsertDispatchConversationAffinity({
    conversationKey: "resp-new",
    provider: "codex",
    modelId: "gpt-5.3-codex",
    connectionId: "conn-12",
    sessionId: "sess-12",
  });

  assert.equal(updated.conversationKey, "resp-new");
  assert.equal(updated.connectionId, "conn-12");
  assert.equal(updated.sessionId, "sess-12");
  assert.equal(
    store.getDispatchConversationAffinity("resp-new")?.connectionId,
    "conn-12",
  );
});
