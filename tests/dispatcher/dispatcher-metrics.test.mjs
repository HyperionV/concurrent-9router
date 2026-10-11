import test from "node:test";
import assert from "node:assert/strict";

const { getSqlite } = await import("@/lib/sqlite/runtime.js");
const { dispatcherMetricsAggregator } = await import("@/lib/dispatcher/metricsAggregator.js");
const { rollupHourlyDispatcherMetrics } = await import("@/lib/sqlite/dispatcherMetrics/rollup.js");
const { getDispatcherStatusSnapshot } = await import("@/lib/dispatcher/metrics.js");
const { insertDispatchRequest, insertDispatchAttempt } = await import(
  "@/lib/sqlite/dispatcherStore.js"
);
const {
  insertImageDispatchRequest,
  insertImageDispatchAttempt,
  listImageDispatchAttemptsByState,
} = await import("@/lib/sqlite/imageDispatcherStore.js");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// A fixed "now" in the middle of an hour keeps step boundaries predictable.
const NOW = Date.UTC(2026, 9, 11, 12, 30, 0);
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;

/** Records one terminal attempt through the production aggregator. */
function recordAttempt({
  provider,
  finishedAtMs,
  state = "completed",
  modelId = "gpt-5.5",
  connectionId = "acct_a",
  queueWaitMs = 100,
  ttftMs = 400,
  durationMs = 2000,
}) {
  const queueEnteredAtMs = finishedAtMs - durationMs;
  const leasedAtMs = queueEnteredAtMs + queueWaitMs;
  dispatcherMetricsAggregator.recordAttemptCompletion({
    id: `att_${++seq}`,
    provider,
    modelId,
    connectionId,
    state,
    queueEnteredAt: iso(queueEnteredAtMs),
    leasedAt: iso(leasedAtMs),
    connectStartedAt: iso(leasedAtMs),
    firstProgressAt: ttftMs === null ? null : iso(leasedAtMs + ttftMs),
    finishedAt: iso(finishedAtMs),
  });
}

function insertUsage({ provider, timestampMs, prompt, cached, completion, connectionId = "acct_a" }) {
  getSqlite()
    .prepare(
      `INSERT INTO usage_events (timestamp, provider, model_id, connection_id, prompt_tokens, completion_tokens, cached_tokens)
       VALUES (?, ?, 'gpt-5.5', ?, ?, ?, ?)`,
    )
    .run(iso(timestampMs), provider, connectionId, prompt, completion, cached);
}

function history(provider, range, connectionIds = ["acct_a"]) {
  return getDispatcherStatusSnapshot({
    provider,
    settings: {},
    inMemory: null,
    connectionViews: connectionIds.map((id) => ({ id, name: id })),
    view: "history",
    range,
    nowMs: NOW,
  }).history;
}

test("a second flush into the same minute keeps its latency samples", () => {
  const provider = "metrics-two-flushes";
  recordAttempt({ provider, finishedAtMs: NOW - 10_000, ttftMs: 400 });
  dispatcherMetricsAggregator.flushToSqlite();
  recordAttempt({ provider, finishedAtMs: NOW - 5_000, ttftMs: 20_000 });
  dispatcherMetricsAggregator.flushToSqlite();

  const { dispatch } = history(provider, "1h").aggregates.current;
  assert.equal(dispatch.attempts, 2);
  assert.equal(dispatch.ttft.samples, 2);
  assert.equal(dispatch.ttft.avgMs, 10_200);
  assert.equal(dispatch.ttft.p95Ms, 30_000); // the 20s sample's histogram bin
});

test("the 1h totals cover only the last hour and compare against the hour before", () => {
  const provider = "metrics-range-scope";
  recordAttempt({ provider, finishedAtMs: NOW - 10 * MINUTE });
  recordAttempt({ provider, finishedAtMs: NOW - 70 * MINUTE, state: "failed" });
  recordAttempt({ provider, finishedAtMs: NOW - 5 * HOUR });
  dispatcherMetricsAggregator.flushToSqlite();

  const { current, previous } = history(provider, "1h").aggregates;
  assert.equal(current.dispatch.attempts, 1);
  assert.equal(previous.dispatch.attempts, 1);
  assert.equal(previous.dispatch.failed, 1);
  assert.equal(history(provider, "24h").aggregates.current.dispatch.attempts, 3);
});

test("client cancellations are counted apart and do not lower the success rate", () => {
  const provider = "metrics-cancelled";
  recordAttempt({ provider, finishedAtMs: NOW - MINUTE });
  recordAttempt({ provider, finishedAtMs: NOW - MINUTE, state: "cancelled", ttftMs: null });
  recordAttempt({ provider, finishedAtMs: NOW - MINUTE, state: "failed" });
  dispatcherMetricsAggregator.flushToSqlite();

  const { dispatch } = history(provider, "1h").aggregates.current;
  assert.deepEqual(
    [dispatch.completed, dispatch.failed, dispatch.cancelled],
    [1, 1, 1],
  );
  assert.equal(dispatch.successRate, 0.5);
});

test("the cache hit rate is the cached share of prompt tokens", () => {
  const provider = "metrics-cache";
  // prompt_tokens already includes the cached part, as providers report it.
  insertUsage({ provider, timestampMs: NOW - MINUTE, prompt: 10_000, cached: 8_000, completion: 500 });
  const { traffic } = history(provider, "1h").aggregates.current;
  assert.equal(traffic.cacheHitRate, 0.8);
  assert.equal(traffic.totalTokens, 10_500);
});

test("7d stats read rolled-up hours and recent minutes without gaps or double counting", () => {
  const provider = "metrics-rollup";
  recordAttempt({ provider, finishedAtMs: NOW - 3 * 24 * HOUR, modelId: "old-model" });
  recordAttempt({ provider, finishedAtMs: NOW - 2 * HOUR });
  recordAttempt({ provider, finishedAtMs: NOW - 5 * MINUTE });
  dispatcherMetricsAggregator.flushToSqlite();

  const first = rollupHourlyDispatcherMetrics({ nowMs: NOW });
  assert.equal(first.rolledUntil, iso(Date.UTC(2026, 9, 11, 12)));
  const week = history(provider, "7d");
  assert.equal(week.aggregates.current.dispatch.attempts, 3);
  assert.equal(
    week.timeline.reduce((total, point) => total + point.attempts, 0),
    3,
  );
  assert.equal(week.timeline.length, 168);
  // Older than the 24h attempt ledger: still present in the 7d model stats.
  assert.equal(week.models.find((m) => m.modelId === "old-model")?.dispatch.attempts, 1);

  // A minute flushed late into the last rolled hour is picked up next pass,
  // and an unchanged history is not reprocessed.
  recordAttempt({ provider, finishedAtMs: NOW - 45 * MINUTE });
  dispatcherMetricsAggregator.flushToSqlite();
  const second = rollupHourlyDispatcherMetrics({ nowMs: NOW + 10 * MINUTE });
  assert.ok(second.hourlyRows < first.hourlyRows);
  assert.equal(history(provider, "7d").aggregates.current.dispatch.attempts, 4);
});

test("the live view lists queued and in-flight work and the latest finished attempts", () => {
  const provider = "metrics-live";
  const request = (id, status) =>
    insertDispatchRequest({ id, provider, modelId: "gpt-5.5", status, queuedAt: iso(NOW - 30_000) });
  request("req_queued", "queued");
  insertDispatchAttempt({ id: "att_queued", requestId: "req_queued", attemptIndex: 0, provider, modelId: "gpt-5.5", state: "queued" });
  request("req_running", "leased");
  insertDispatchAttempt({
    id: "att_running", requestId: "req_running", attemptIndex: 0, provider, modelId: "gpt-5.5",
    connectionId: "acct_a", state: "streaming", queueEnteredAt: iso(NOW - 30_000), leasedAt: iso(NOW - 29_000),
  });
  request("req_done", "completed");
  insertDispatchAttempt({
    id: "att_done", requestId: "req_done", attemptIndex: 0, provider, modelId: "gpt-5.5", connectionId: "acct_a",
    state: "completed", queueEnteredAt: iso(NOW - 20_000), leasedAt: iso(NOW - 19_500),
    connectStartedAt: iso(NOW - 19_500), firstProgressAt: iso(NOW - 19_000), finishedAt: iso(NOW - 10_000),
  });

  const { live } = getDispatcherStatusSnapshot({
    provider,
    settings: {},
    inMemory: { occupancyByConnection: { acct_a: 1 } },
    connectionViews: [{ id: "acct_a", name: "A" }],
    view: "live",
    range: "1h",
    nowMs: NOW,
  });
  assert.deepEqual(live.queue.requests.map((r) => r.id), ["req_queued"]);
  assert.deepEqual(live.active.attempts.map((a) => a.id), ["att_running"]);
  assert.equal(live.tape[0].id, "att_done");
  assert.equal(live.tape[0].ttftMs, 500);
  assert.equal(live.occupancy[0].occupiedSlots, 1);
});

test("image attempts are listed newest first", () => {
  for (const [index, minutesAgo] of [30, 10, 20].entries()) {
    insertImageDispatchRequest({ id: `img_req_${index}`, provider: "codex", modelId: "gpt-image-1" });
    insertImageDispatchAttempt({
      id: `img_att_${index}`, requestId: `img_req_${index}`, attemptIndex: 0, provider: "codex",
      modelId: "gpt-image-1", state: "completed", queueEnteredAt: iso(NOW - minutesAgo * MINUTE),
    });
  }
  const recent = listImageDispatchAttemptsByState(["completed"], "codex", { limit: 2 });
  assert.deepEqual(recent.map((a) => a.id), ["img_att_1", "img_att_2"]);
});
