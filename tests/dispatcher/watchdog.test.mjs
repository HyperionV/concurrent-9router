import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-watchdog-"));
process.env.DATA_DIR = tempRoot;

const runtime = await import("../../src/lib/sqlite/runtime.js");
const store = await import("../../src/lib/sqlite/dispatcherStore.js");
const { createDispatcherCore } =
  await import("../../src/lib/dispatcher/core.js");
const { createDispatcherWatchdog } =
  await import("../../src/lib/dispatcher/watchdog.js");
const { DISPATCH_ATTEMPT_STATE } =
  await import("../../src/lib/dispatcher/types.js");

function makeConnection(id) {
  return {
    id,
    provider: "codex",
    priority: 1,
    connectionName: id,
    providerSpecificData: {},
  };
}

test("watchdog times out stalled active attempts with explicit classification", async () => {
  runtime.getSqlite();
  store.clearDispatchTables();

  const dispatcher = createDispatcherCore({
    provider: "codex",
    getConnections: async () => [makeConnection("a")],
    slotsPerConnection: 1,
    timeoutPolicy: {
      connectTimeoutMs: 10,
      ttftTimeoutMs: 10,
      idleTimeoutMs: 10,
      attemptDeadlineMs: 10_000,
      queueTtlMs: 10_000,
    },
  });

  const queued = await dispatcher.enqueueRequest({
    id: "req-watchdog",
    provider: "codex",
    modelId: "gpt-5.3-codex",
  });

  const [lease] = await dispatcher.tryLeaseAvailableWork();
  assert.ok(lease);

  const leasedAt = new Date(Date.now() - 60_000).toISOString();
  store.transitionDispatchAttempt(
    lease.attemptId,
    DISPATCH_ATTEMPT_STATE.LEASED,
    DISPATCH_ATTEMPT_STATE.LEASED,
    { connectStartedAt: leasedAt },
  );

  const watchdog = createDispatcherWatchdog({
    provider: "codex",
    dispatcher,
    timeoutPolicy: {
      ttftTimeoutMs: 50,
      connectTimeoutMs: 50,
      idleTimeoutMs: 50,
      attemptDeadlineMs: 10_000,
      queueTtlMs: 10_000,
    },
  });

  const result = await watchdog.runSweep();
  assert.equal(result.timedOut.length, 1);
  assert.equal(result.timedOut[0].timeoutKind, "ttft_timeout");

  const attempt = store.getDispatchAttempt(lease.attemptId);
  assert.equal(attempt.state, "timed_out");
  assert.equal(attempt.timeoutKind, "ttft_timeout");
});

test("watchdog expires queued requests by timing out their queued attempt", async () => {
  runtime.getSqlite();
  store.clearDispatchTables();

  const dispatcher = createDispatcherCore({
    provider: "codex",
    getConnections: async () => [makeConnection("a")],
    slotsPerConnection: 1,
    timeoutPolicy: {
      connectTimeoutMs: 10_000,
      ttftTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      attemptDeadlineMs: 10_000,
      queueTtlMs: 50,
    },
  });

  const queued = await dispatcher.enqueueRequest({
    id: "req-queued-timeout",
    provider: "codex",
    modelId: "gpt-5.3-codex",
  });

  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  store.updateDispatchRequestStatus(queued.request.id, "queued", {
    metadata: queued.request.metadata,
  });
  runtime
    .getSqlite()
    .prepare("UPDATE dispatch_requests SET queued_at = ? WHERE id = ?")
    .run(expiredAt, queued.request.id);

  const watchdog = createDispatcherWatchdog({
    provider: "codex",
    dispatcher,
    timeoutPolicy: {
      queueTtlMs: 50,
      connectTimeoutMs: 10_000,
      ttftTimeoutMs: 10_000,
      idleTimeoutMs: 10_000,
      attemptDeadlineMs: 10_000,
    },
  });

  const result = await watchdog.runSweep();
  assert.equal(result.timedOut.length, 1);
  assert.equal(result.timedOut[0].timeoutKind, "queue_expired");

  const request = store.getDispatchRequest(queued.request.id);
  const attempt = store.getLatestDispatchAttemptForRequest(queued.request.id);
  assert.equal(request.status, "timed_out");
  assert.equal(attempt.state, "timed_out");
  assert.equal(attempt.timeoutKind, "queue_expired");
});
