import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "dispatcher-retention-"),
);
process.env.DATA_DIR = tempRoot;

const runtime = await import("../../src/lib/sqlite/runtime.js");
const store = await import("../../src/lib/sqlite/dispatcherStore.js");

test("pruneDispatchLedger removes stale terminal rows but preserves active data", () => {
  runtime.getSqlite();
  store.clearDispatchTables();

  const staleTime = "2026-04-18T00:00:00.000Z";
  const freshTime = "2026-04-20T00:00:00.000Z";
  const retainSince = "2026-04-19T00:00:00.000Z";

  store.insertDispatchRequest({
    id: "req-stale",
    provider: "codex",
    modelId: "gpt-5.4-low",
    status: "completed",
    queuedAt: staleTime,
    completedAt: staleTime,
  });
  store.insertDispatchAttempt({
    id: "att-stale",
    requestId: "req-stale",
    attemptIndex: 0,
    provider: "codex",
    modelId: "gpt-5.4-low",
    state: "completed",
    queueEnteredAt: staleTime,
    finishedAt: staleTime,
    terminalReason: "success",
  });
  store.insertDispatchAttemptEvent({
    id: "evt-stale",
    attemptId: "att-stale",
    eventType: "completed",
    at: staleTime,
  });

  store.insertDispatchRequest({
    id: "req-fresh-active",
    provider: "codex",
    modelId: "gpt-5.4-low",
    status: "running",
    queuedAt: freshTime,
  });
  store.insertDispatchAttempt({
    id: "att-fresh-active",
    requestId: "req-fresh-active",
    attemptIndex: 0,
    provider: "codex",
    modelId: "gpt-5.4-low",
    state: "streaming",
    queueEnteredAt: freshTime,
    leasedAt: freshTime,
  });

  store.upsertDispatchConversationAffinity({
    conversationKey: "conv-stale",
    provider: "codex",
    modelId: "gpt-5.4-low",
    connectionId: "conn-1",
    state: "active",
    updatedAt: staleTime,
  });
  store.upsertDispatchConversationAffinity({
    conversationKey: "conv-fresh",
    provider: "codex",
    modelId: "gpt-5.4-low",
    connectionId: "conn-2",
    state: "active",
    updatedAt: freshTime,
  });

  const result = store.pruneDispatchLedger({
    retainAttemptsSince: retainSince,
    retainAffinitySince: retainSince,
  });

  assert.equal(result.deletedEvents, 1);
  assert.equal(result.deletedAttempts, 1);
  assert.equal(result.deletedRequests, 1);
  assert.equal(result.deletedAffinity, 1);

  assert.equal(store.getDispatchRequest("req-stale"), null);
  assert.equal(store.getDispatchAttempt("att-stale"), null);
  assert.equal(store.listDispatchAttemptEvents("att-stale").length, 0);
  assert.equal(store.getDispatchConversationAffinity("conv-stale"), null);

  assert.notEqual(store.getDispatchRequest("req-fresh-active"), null);
  assert.notEqual(store.getDispatchAttempt("att-fresh-active"), null);
  assert.notEqual(store.getDispatchConversationAffinity("conv-fresh"), null);
});
