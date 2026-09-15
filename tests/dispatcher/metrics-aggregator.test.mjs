import test from "node:test";
import assert from "node:assert/strict";
import { dispatcherMetricsAggregator, toMinuteBucketIso } from "../../src/lib/dispatcher/metricsAggregator.js";
import { getSqlite } from "../../src/lib/sqlite/runtime.js";
import {
  queryDispatcherTimeline,
  queryDispatcherAggregates,
  rollupHourlyDispatcherMetrics,
  pruneDispatcherMetricsBuckets,
} from "../../src/lib/sqlite/dispatcherMetricsStore.js";

test("dispatcherMetricsAggregator buffers attempts in memory with O(1) cost", () => {
  dispatcherMetricsAggregator.clear();

  const now = Date.now();
  dispatcherMetricsAggregator.recordAttemptCompletion({
    id: "att_1",
    provider: "codex",
    modelId: "gpt-5.5",
    connectionId: "conn_1",
    state: "completed",
    queueEnteredAt: new Date(now - 3000).toISOString(),
    leasedAt: new Date(now - 2800).toISOString(), // 200ms queue wait
    connectStartedAt: new Date(now - 2800).toISOString(),
    firstProgressAt: new Date(now - 2200).toISOString(), // 600ms ttft
    finishedAt: new Date(now).toISOString(), // 3000ms total
  });

  const buffer = dispatcherMetricsAggregator.getBufferForProvider("codex");
  assert.equal(buffer.length, 1);
  assert.equal(buffer[0].requestCount, 1);
  assert.equal(buffer[0].completedCount, 1);
  assert.equal(buffer[0].queueWaitMsSum, 200);
  assert.equal(buffer[0].ttftMsSum, 600);
  assert.equal(buffer[0].totalDurationMsSum, 3000);
});

test("flushToSqlite writes in-memory buckets to SQLite and allows timeline queries", () => {
  const flushed = dispatcherMetricsAggregator.flushToSqlite();
  assert.equal(flushed, 1);
  assert.equal(dispatcherMetricsAggregator.getBufferForProvider("codex").length, 0);

  const aggregates = queryDispatcherAggregates("codex");
  assert.ok(aggregates.totalRequests >= 1);
  assert.ok(aggregates.totalCompleted >= 1);
  assert.ok(aggregates.p50TtftMs > 0);

  const timeline = queryDispatcherTimeline({ provider: "codex", range: "1h" });
  assert.ok(timeline.length >= 1);
  const point = timeline[timeline.length - 1];
  assert.ok(point.requests >= 1);
  assert.ok(point.p50TtftMs > 0);
});

test("hourly downsampling and retention pruning operate without errors", () => {
  const downsampled = rollupHourlyDispatcherMetrics(new Date().toISOString());
  assert.ok(typeof downsampled === "number");

  const pruned = pruneDispatcherMetricsBuckets({
    retainMinutesSince: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    retainHoursSince: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  });
  assert.ok(typeof pruned.deletedMinutes === "number");
  assert.ok(typeof pruned.deletedHours === "number");
});
