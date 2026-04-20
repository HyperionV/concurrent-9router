import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-status-"));
process.env.DATA_DIR = tempRoot;

const runtime = await import("../../src/lib/sqlite/runtime.js");
const store = await import("../../src/lib/sqlite/dispatcherStore.js");
const { getDispatcherStatusSnapshot } =
  await import("../../src/lib/dispatcher/metrics.js");

test("dispatcher status snapshot summarizes queued active and terminal ledger state", () => {
  runtime.getSqlite();
  store.clearDispatchTables();

  store.insertDispatchRequest({
    id: "req-queued",
    provider: "codex",
    modelId: "gpt-5.4-low",
    status: "queued",
    queuedAt: "2026-04-20T00:00:00.000Z",
  });
  store.insertDispatchAttempt({
    id: "att-queued",
    requestId: "req-queued",
    attemptIndex: 0,
    provider: "codex",
    modelId: "gpt-5.4-low",
    state: "queued",
    queueEnteredAt: "2026-04-20T00:00:00.000Z",
  });

  store.insertDispatchRequest({
    id: "req-active",
    provider: "codex",
    modelId: "gpt-5.4-low",
    status: "running",
    queuedAt: "2026-04-20T00:00:01.000Z",
  });
  store.insertDispatchAttempt({
    id: "att-active",
    requestId: "req-active",
    attemptIndex: 0,
    provider: "codex",
    modelId: "gpt-5.4-low",
    state: "streaming",
    connectionId: "conn-12",
    pathMode: "connection-proxy",
    queueEnteredAt: "2026-04-20T00:00:01.000Z",
    leasedAt: "2026-04-20T00:00:02.000Z",
    streamStartedAt: "2026-04-20T00:00:03.000Z",
  });
  store.insertDispatchAttemptEvent({
    id: "evt-active",
    attemptId: "att-active",
    eventType: "stream_started",
    payload: { pathMode: "connection-proxy" },
  });

  store.insertDispatchRequest({
    id: "req-terminal",
    provider: "codex",
    modelId: "gpt-5.4-low",
    status: "timed_out",
    queuedAt: "2026-04-20T00:00:04.000Z",
    completedAt: "2026-04-20T00:01:00.000Z",
  });
  store.insertDispatchAttempt({
    id: "att-terminal",
    requestId: "req-terminal",
    attemptIndex: 0,
    provider: "codex",
    modelId: "gpt-5.4-low",
    state: "timed_out",
    connectionId: "conn-11",
    pathMode: "direct",
    queueEnteredAt: "2026-04-20T00:00:04.000Z",
    leasedAt: "2026-04-20T00:00:05.000Z",
    finishedAt: "2026-04-20T00:01:00.000Z",
    timeoutKind: "idle_timeout",
    terminalReason: "timeout",
  });

  const snapshot = getDispatcherStatusSnapshot({
    provider: "codex",
    settings: {
      dispatcherEnabled: true,
      dispatcherShadowMode: false,
      dispatcherCodexOnly: true,
      dispatcherSlotsPerConnection: 5,
    },
    inMemory: {
      occupancyByConnection: {
        "conn-12": 1,
        "conn-11": 0,
      },
      timeoutPolicy: {
        queueTtlMs: 600000,
      },
      pathHealth: {},
    },
    connectionViews: [
      {
        id: "conn-12",
        displayName: "Account 12",
        providerSpecificData: {
          connectionProxyPoolId: "pool-1",
          strictProxy: true,
        },
      },
      {
        id: "conn-11",
        displayName: "Account 11",
        providerSpecificData: {
          connectionProxyPoolId: null,
          strictProxy: false,
        },
      },
    ],
  });

  assert.equal(snapshot.queued.count, 1);
  assert.equal(snapshot.queued.byModel["gpt-5.4-low"], 1);

  assert.equal(snapshot.active.count, 1);
  assert.equal(snapshot.active.byConnection["conn-12"], 1);
  assert.equal(snapshot.active.byPathMode["connection-proxy"], 1);

  assert.equal(snapshot.terminal.count, 1);
  assert.equal(snapshot.terminal.byState.timed_out, 1);
  assert.equal(snapshot.terminal.byTimeoutKind.idle_timeout, 1);

  assert.equal(snapshot.mode, "managed");
  assert.equal(snapshot.settings.dispatcherSlotsPerConnection, 5);
  assert.equal(snapshot.capacity.activeConnections, 2);
  assert.equal(snapshot.capacity.totalCapacity, 10);
  assert.equal(snapshot.capacity.activeLeases, 1);
  assert.equal(snapshot.connections.length, 2);
  assert.equal(snapshot.connections[0].connectionId, "conn-12");
  assert.equal(snapshot.connections[0].occupiedSlots, 1);
  assert.equal(snapshot.connections[0].capacity, 5);
  assert.equal(snapshot.connections[0].availableSlots, 4);
  assert.equal(snapshot.connections[0].strictProxy, true);
  assert.equal(snapshot.connections[0].proxyPoolId, "pool-1");
  assert.equal(snapshot.models.length, 1);
  assert.equal(snapshot.models[0].modelId, "gpt-5.4-low");
  assert.equal(snapshot.models[0].queued, 1);
  assert.equal(snapshot.models[0].active, 1);
  assert.equal(snapshot.models[0].timedOut, 1);
  assert.equal(snapshot.paths.length, 2);
  assert.equal(snapshot.paths[0].total >= 1, true);
});
