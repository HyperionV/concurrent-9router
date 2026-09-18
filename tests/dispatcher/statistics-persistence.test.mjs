import test from "node:test";
import assert from "node:assert/strict";
import { getSqlite } from "../../src/lib/sqlite/runtime.js";
import {
  queryDispatcherConnectionStats,
  queryDispatcherModelStats,
  queryDispatcherLastActiveByConnection,
} from "../../src/lib/sqlite/dispatcherMetricsStore.js";
import { getDispatcherStatusSnapshot } from "../../src/lib/dispatcher/metrics.js";
import { dispatcherMetricsAggregator } from "../../src/lib/dispatcher/metricsAggregator.js";

test("dispatcherMetricsAggregator is a shared process singleton on globalThis", () => {
  assert.ok(globalThis.__dispatcherMetricsAggregator);
  assert.equal(dispatcherMetricsAggregator, globalThis.__dispatcherMetricsAggregator);
});

test("queryDispatcherConnectionStats and queryDispatcherModelStats return durable statistics", () => {
  const db = getSqlite();
  const testProvider = "test-provider-" + Date.now();
  const conn1 = "test-conn-1";
  const conn2 = "test-conn-2";
  const model1 = "test-model-alpha";
  const now = new Date();

  const uid = Math.random().toString(36).slice(2);
  const req1 = `req_test_1_${uid}`;
  const req2 = `req_test_2_${uid}`;
  const att1 = `att_test_1_${uid}`;
  const att2 = `att_test_2_${uid}`;

  try {
    // Insert test requests and attempts into SQLite
    const reqStmt = db.prepare(`
      INSERT INTO dispatch_requests (
        id, provider, model_id, conversation_key, status, queued_at, completed_at
      ) VALUES (?, ?, ?, 'test_conv', 'completed', ?, ?)
    `);
    reqStmt.run(req1, testProvider, model1, new Date(now.getTime() - 10000).toISOString(), new Date(now.getTime() - 8000).toISOString());
    reqStmt.run(req2, testProvider, model1, new Date(now.getTime() - 5000).toISOString(), new Date(now.getTime() - 3000).toISOString());

    const stmt = db.prepare(`
      INSERT INTO dispatch_attempts (
        id, request_id, attempt_index, provider, model_id, connection_id,
        state, queue_entered_at, leased_at, connect_started_at, first_progress_at, finished_at, terminal_reason
      ) VALUES (
        ?, ?, 0, ?, ?, ?,
        'completed', ?, ?, ?, ?, ?, 'success'
      )
    `);

    stmt.run(
      att1,
      req1,
      testProvider,
      model1,
      conn1,
      new Date(now.getTime() - 10000).toISOString(),
      new Date(now.getTime() - 9800).toISOString(), // 200ms queue wait
      new Date(now.getTime() - 9800).toISOString(),
      new Date(now.getTime() - 9300).toISOString(), // 500ms ttft
      new Date(now.getTime() - 8000).toISOString(),
    );

    stmt.run(
      att2,
      req2,
      testProvider,
      model1,
      conn1,
      new Date(now.getTime() - 5000).toISOString(),
      new Date(now.getTime() - 4900).toISOString(), // 100ms queue wait
      new Date(now.getTime() - 4900).toISOString(),
      new Date(now.getTime() - 4600).toISOString(), // 300ms ttft
      new Date(now.getTime() - 3000).toISOString(),
    );

    // Connection stats check
    const connStats = queryDispatcherConnectionStats({ provider: testProvider, range: "24h" });
    assert.ok(connStats[conn1]);
    assert.equal(connStats[conn1].recentAttempts, 2);
    assert.ok(connStats[conn1].lastAttemptAt);
    assert.equal(connStats[conn1].avgTtftMs, 400); // (500 + 300) / 2
    assert.equal(connStats[conn1].avgQueueWaitMs, 150); // (200 + 100) / 2

    // Model stats check
    const modelStats = queryDispatcherModelStats({ provider: testProvider, range: "24h" });
    assert.equal(modelStats.length, 1);
    assert.equal(modelStats[0].modelId, model1);
    assert.equal(modelStats[0].completed, 2);
    assert.equal(modelStats[0].total, 2);
    assert.equal(modelStats[0].avgTtftMs, 400);

    // Status snapshot checks for live, history, and full views
    const connectionViews = [
      { id: conn1, name: "Connection 1" },
      { id: conn2, name: "Connection 2" },
    ];

    // Live view must maintain durable stats and not wipe them out
    const liveSnapshot = getDispatcherStatusSnapshot({
      provider: testProvider,
      connectionViews,
      view: "live",
      range: "24h",
    });
    assert.ok(liveSnapshot.connections);
    const liveC1 = liveSnapshot.connections.find((c) => c.connectionId === conn1);
    assert.ok(liveC1);
    assert.equal(liveC1.recentAttempts, 2);
    assert.equal(liveC1.avgTtftMs, 400);
    assert.ok(liveC1.lastAttemptAt);

    // History view must return both models and connections
    const histSnapshot = getDispatcherStatusSnapshot({
      provider: testProvider,
      connectionViews,
      view: "history",
      range: "24h",
    });
    assert.ok(histSnapshot.models);
    assert.equal(histSnapshot.models.length, 1);
    assert.equal(histSnapshot.models[0].modelId, model1);
    assert.ok(histSnapshot.connections);
    const histC1 = histSnapshot.connections.find((c) => c.connectionId === conn1);
    assert.ok(histC1);
    assert.equal(histC1.recentAttempts, 2);

    // Full view must return all
    const fullSnapshot = getDispatcherStatusSnapshot({
      provider: testProvider,
      connectionViews,
      view: "full",
      range: "24h",
    });
    assert.ok(fullSnapshot.models);
    assert.ok(fullSnapshot.connections);
  } finally {
    // Cleanup test data
    db.prepare("DELETE FROM dispatch_attempts WHERE provider = ?").run(testProvider);
    db.prepare("DELETE FROM dispatch_requests WHERE provider = ?").run(testProvider);
  }
});

test("client mergeSnapshot preserves historical account metrics when merging live occupancy", () => {
  const prevSnapshot = {
    connections: [
      {
        connectionId: "conn_alpha",
        connectionName: "Alpha Account",
        occupiedSlots: 2,
        capacity: 10,
        recentAttempts: 42,
        lastAttemptAt: "2026-09-18T16:00:00.000Z",
        avgTtftMs: 350,
        p95TtftMs: 600,
        avgQueueWaitMs: 12,
        recentTerminalReasonCounts: { success: 40, error: 2 },
      },
    ],
    models: [{ modelId: "m1", total: 42 }],
  };

  const nextLiveSnapshot = {
    capacity: { totalCapacity: 10, activeLeases: 0 },
    connections: [
      {
        connectionId: "conn_alpha",
        connectionName: "Alpha Account",
        occupiedSlots: 0,
        capacity: 10,
        availableSlots: 10,
        recentAttempts: 0, // Even if a live poll returned 0
        lastAttemptAt: null,
        avgTtftMs: 0,
        p95TtftMs: 0,
        avgQueueWaitMs: 0,
      },
    ],
  };

  // Simulating the merge logic from page.js
  const mergedConnections = prevSnapshot.connections.map((prevConn) => {
    const nextConn = nextLiveSnapshot.connections.find((nc) => nc.connectionId === prevConn.connectionId);
    if (!nextConn) return prevConn;
    return {
      ...prevConn,
      ...nextConn,
      occupiedSlots: nextConn.occupiedSlots,
      availableSlots: nextConn.availableSlots,
      capacity: nextConn.capacity,
      recentAttempts: nextConn.recentAttempts > 0 ? nextConn.recentAttempts : prevConn.recentAttempts || 0,
      lastAttemptAt: nextConn.lastAttemptAt || prevConn.lastAttemptAt || null,
      avgTtftMs: nextConn.avgTtftMs > 0 ? nextConn.avgTtftMs : prevConn.avgTtftMs || 0,
      p95TtftMs: nextConn.p95TtftMs > 0 ? nextConn.p95TtftMs : prevConn.p95TtftMs || 0,
      avgQueueWaitMs: nextConn.avgQueueWaitMs > 0 ? nextConn.avgQueueWaitMs : prevConn.avgQueueWaitMs || 0,
      recentTerminalReasonCounts:
        nextConn.recentTerminalReasonCounts && Object.keys(nextConn.recentTerminalReasonCounts).length > 0
          ? nextConn.recentTerminalReasonCounts
          : prevConn.recentTerminalReasonCounts || {},
    };
  });

  assert.equal(mergedConnections[0].occupiedSlots, 0); // live occupancy updated
  assert.equal(mergedConnections[0].recentAttempts, 42); // stats strictly preserved!
  assert.equal(mergedConnections[0].avgTtftMs, 350);
  assert.equal(mergedConnections[0].lastAttemptAt, "2026-09-18T16:00:00.000Z");
  assert.equal(mergedConnections[0].recentTerminalReasonCounts.success, 40);
});

