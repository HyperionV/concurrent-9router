/**
 * The 5 minute queue limit applies to waiting for a slot only. These tests
 * drive the real watchdog against the real ledger with an explicit clock.
 */
import test from "node:test";
import assert from "node:assert/strict";

const MINUTE_MS = 60_000;
const iso = (ms) => new Date(ms).toISOString();

async function freshDispatcherWithWatchdog() {
  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { clearDispatchTables } = await import("@/lib/sqlite/dispatcherStore.js");
  clearDispatchTables();
  const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
  const { createDispatcherWatchdog } = await import("@/lib/dispatcher/watchdog.js");
  const dispatcher = createDispatcherCore({
    provider: "codex",
    getConnections: async () => [{ id: "limits_a", priority: 1, providerSpecificData: {} }],
    getSlotsPerConnection: () => 1,
  });
  return { dispatcher, watchdog: createDispatcherWatchdog({ provider: "codex", dispatcher }) };
}

/** Lease the only slot and report stream progress as of `progressAt`. */
async function startStreamingWithProgress(dispatcher, progressAt) {
  const queued = await dispatcher.enqueueRequest({ provider: "codex", modelId: "gpt-5-codex" });
  const lease = await dispatcher.tryLeaseRequest(queued.request.id);
  assert.ok(lease, "the first request should get the only slot");
  await dispatcher.markAttemptStreamStarted(lease.attemptId, {
    streamStartedAt: iso(progressAt),
  });
  await dispatcher.markAttemptProgress(lease.attemptId, { at: iso(progressAt) });
  return lease;
}

test("a leased stream that is still making progress survives past the 5 minute queue limit", async () => {
  const { QUEUE_WAITING_LIMIT_MS } = await import("@/lib/dispatcher/timeoutPolicy.js");
  const { getDispatchAttempt } = await import("@/lib/sqlite/dispatcherStore.js");
  const { dispatcher, watchdog } = await freshDispatcherWithWatchdog();

  // 5.5 minutes after the request arrived, with a token received 5 seconds ago.
  const now = Date.now() + 5.5 * MINUTE_MS;
  const lease = await startStreamingWithProgress(dispatcher, now - 5_000);
  const attempt = getDispatchAttempt(lease.attemptId);
  assert.ok(
    now - new Date(attempt.queueEnteredAt).getTime() > QUEUE_WAITING_LIMIT_MS,
    "the attempt must be older than the queue limit for this test to mean anything",
  );

  const sweep = await watchdog.runSweep(now);

  assert.deepEqual(sweep.timedOut, []);
  assert.equal(getDispatchAttempt(lease.attemptId).state, "streaming");
  assert.equal(dispatcher.getInMemorySnapshot().occupancyByConnection.limits_a, 1);
});

test("a request still waiting for a slot after the queue limit is expired, a running stream beside it is not", async () => {
  const { QUEUE_WAITING_LIMIT_MS } = await import("@/lib/dispatcher/timeoutPolicy.js");
  const { getDispatchAttempt, getDispatchRequest } = await import(
    "@/lib/sqlite/dispatcherStore.js"
  );
  const { dispatcher, watchdog } = await freshDispatcherWithWatchdog();

  const startedAt = Date.now();
  const lease = await startStreamingWithProgress(dispatcher, startedAt);
  const waiting = await dispatcher.enqueueRequest({ provider: "codex", modelId: "gpt-5-codex" });

  // One second inside the limit: nothing is expired yet.
  const beforeLimit = startedAt + QUEUE_WAITING_LIMIT_MS - 1_000;
  await dispatcher.markAttemptProgress(lease.attemptId, { at: iso(beforeLimit - 1_000) });
  const early = await watchdog.runSweep(beforeLimit);
  assert.deepEqual(early.timedOut, []);
  assert.equal(getDispatchAttempt(waiting.attempt.id).state, "queued");

  // One second past the limit, with the running stream's last token just received.
  const late = startedAt + QUEUE_WAITING_LIMIT_MS + 1_000;
  await dispatcher.markAttemptProgress(lease.attemptId, { at: iso(late - 1_000) });
  await watchdog.runSweep(late);

  const expired = getDispatchAttempt(waiting.attempt.id);
  assert.equal(expired.state, "timed_out");
  assert.equal(expired.timeoutKind, "queue_expired");
  assert.equal(getDispatchRequest(waiting.request.id).status, "timed_out");
  assert.equal(getDispatchAttempt(lease.attemptId).state, "streaming");
});
