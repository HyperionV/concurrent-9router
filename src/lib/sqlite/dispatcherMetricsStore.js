import { getSqlite } from "@/lib/sqlite/runtime.js";
import {
  createEmptyHistogram,
  mergeHistograms,
  parseHistogram,
  calculatePercentiles,
} from "@/lib/dispatcher/histogram.js";

/**
 * Upserts a batch of 1-minute metric buckets in a single transaction.
 * @param {Array<object>} buckets
 */
export function upsertDispatcherMinuteBuckets(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return;
  const db = getSqlite();

  const stmt = db.prepare(`
    INSERT INTO dispatcher_metrics_1m (
      provider, bucket_start, model_id, connection_id,
      request_count, completed_count, failed_count, timed_out_count,
      queue_wait_ms_sum, ttft_ms_sum, total_duration_ms_sum,
      queue_wait_ms_max, ttft_ms_max, total_duration_ms_max,
      ttft_hist_json, queue_hist_json
    ) VALUES (
      @provider, @bucketStart, @modelId, @connectionId,
      @requestCount, @completedCount, @failedCount, @timedOutCount,
      @queueWaitMsSum, @ttftMsSum, @totalDurationMsSum,
      @queueWaitMsMax, @ttftMsMax, @totalDurationMsMax,
      @ttftHistJson, @queueHistJson
    )
    ON CONFLICT(provider, bucket_start, model_id, connection_id) DO UPDATE SET
      request_count = request_count + excluded.request_count,
      completed_count = completed_count + excluded.completed_count,
      failed_count = failed_count + excluded.failed_count,
      timed_out_count = timed_out_count + excluded.timed_out_count,
      queue_wait_ms_sum = queue_wait_ms_sum + excluded.queue_wait_ms_sum,
      ttft_ms_sum = ttft_ms_sum + excluded.ttft_ms_sum,
      total_duration_ms_sum = total_duration_ms_sum + excluded.total_duration_ms_sum,
      queue_wait_ms_max = MAX(queue_wait_ms_max, excluded.queue_wait_ms_max),
      ttft_ms_max = MAX(ttft_ms_max, excluded.ttft_ms_max),
      total_duration_ms_max = MAX(total_duration_ms_max, excluded.total_duration_ms_max)
  `);

  const runTx = db.transaction((rows) => {
    for (const row of rows) {
      stmt.run({
        provider: row.provider,
        bucketStart: row.bucketStart,
        modelId: row.modelId || "all",
        connectionId: row.connectionId || "all",
        requestCount: Number(row.requestCount) || 0,
        completedCount: Number(row.completedCount) || 0,
        failedCount: Number(row.failedCount) || 0,
        timedOutCount: Number(row.timedOutCount) || 0,
        queueWaitMsSum: Number(row.queueWaitMsSum) || 0,
        ttftMsSum: Number(row.ttftMsSum) || 0,
        totalDurationMsSum: Number(row.totalDurationMsSum) || 0,
        queueWaitMsMax: Number(row.queueWaitMsMax) || 0,
        ttftMsMax: Number(row.ttftMsMax) || 0,
        totalDurationMsMax: Number(row.totalDurationMsMax) || 0,
        ttftHistJson: typeof row.ttftHistJson === "string" ? row.ttftHistJson : JSON.stringify(row.ttftHist || []),
        queueHistJson: typeof row.queueHistJson === "string" ? row.queueHistJson : JSON.stringify(row.queueHist || []),
      });
    }
  });

  runTx(buckets);
}

/**
 * Downsamples minute buckets into hourly buckets.
 * Merges rows where bucket_start is before cutoffIso.
 * @param {string} cutoffIso
 */
export function rollupHourlyDispatcherMetrics(cutoffIso = null) {
  const db = getSqlite();
  const cutoff = cutoffIso || new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Find distinct provider and hour prefixes that have minute data before cutoff
  const rows = db.prepare(`
    SELECT provider, model_id, connection_id,
           strftime('%Y-%m-%dT%H:00:00.000Z', bucket_start) AS hour_bucket,
           SUM(request_count) AS request_count,
           SUM(completed_count) AS completed_count,
           SUM(failed_count) AS failed_count,
           SUM(timed_out_count) AS timed_out_count,
           SUM(queue_wait_ms_sum) AS queue_wait_ms_sum,
           SUM(ttft_ms_sum) AS ttft_ms_sum,
           SUM(total_duration_ms_sum) AS total_duration_ms_sum,
           MAX(queue_wait_ms_max) AS queue_wait_ms_max,
           MAX(ttft_ms_max) AS ttft_ms_max,
           MAX(total_duration_ms_max) AS total_duration_ms_max
    FROM dispatcher_metrics_1m
    WHERE bucket_start < ?
    GROUP BY provider, model_id, connection_id, hour_bucket
  `).all(cutoff);

  if (rows.length === 0) return 0;

  const insertHourStmt = db.prepare(`
    INSERT INTO dispatcher_metrics_1h (
      provider, bucket_start, model_id, connection_id,
      request_count, completed_count, failed_count, timed_out_count,
      queue_wait_ms_sum, ttft_ms_sum, total_duration_ms_sum,
      queue_wait_ms_max, ttft_ms_max, total_duration_ms_max,
      ttft_hist_json, queue_hist_json
    ) VALUES (
      @provider, @bucketStart, @modelId, @connectionId,
      @requestCount, @completedCount, @failedCount, @timedOutCount,
      @queueWaitMsSum, @ttftMsSum, @totalDurationMsSum,
      @queueWaitMsMax, @ttftMsMax, @totalDurationMsMax,
      @ttftHistJson, @queueHistJson
    )
    ON CONFLICT(provider, bucket_start, model_id, connection_id) DO UPDATE SET
      request_count = excluded.request_count,
      completed_count = excluded.completed_count,
      failed_count = excluded.failed_count,
      timed_out_count = excluded.timed_out_count,
      queue_wait_ms_sum = excluded.queue_wait_ms_sum,
      ttft_ms_sum = excluded.ttft_ms_sum,
      total_duration_ms_sum = excluded.total_duration_ms_sum,
      queue_wait_ms_max = excluded.queue_wait_ms_max,
      ttft_ms_max = excluded.ttft_ms_max,
      total_duration_ms_max = excluded.total_duration_ms_max
  `);

  const runRollup = db.transaction(() => {
    for (const row of rows) {
      // Merge histograms for this provider & hour
      const minuteRows = db.prepare(`
        SELECT ttft_hist_json, queue_hist_json
        FROM dispatcher_metrics_1m
        WHERE provider = ? AND model_id = ? AND connection_id = ?
          AND strftime('%Y-%m-%dT%H:00:00.000Z', bucket_start) = ?
      `).all(row.provider, row.model_id, row.connection_id, row.hour_bucket);

      const mergedTtft = createEmptyHistogram();
      const mergedQueue = createEmptyHistogram();
      for (const m of minuteRows) {
        mergeHistograms(mergedTtft, parseHistogram(m.ttft_hist_json));
        mergeHistograms(mergedQueue, parseHistogram(m.queue_hist_json));
      }

      insertHourStmt.run({
        provider: row.provider,
        bucketStart: row.hour_bucket,
        modelId: row.model_id,
        connectionId: row.connection_id,
        requestCount: row.request_count,
        completedCount: row.completed_count,
        failedCount: row.failed_count,
        timedOutCount: row.timed_out_count,
        queueWaitMsSum: row.queue_wait_ms_sum,
        ttftMsSum: row.ttft_ms_sum,
        totalDurationMsSum: row.total_duration_ms_sum,
        queueWaitMsMax: row.queue_wait_ms_max,
        ttftMsMax: row.ttft_ms_max,
        totalDurationMsMax: row.total_duration_ms_max,
        ttftHistJson: JSON.stringify(mergedTtft),
        queueHistJson: JSON.stringify(mergedQueue),
      });
    }
  });

  runRollup();
  return rows.length;
}

/**
 * Prunes expired metrics buckets according to retention policy.
 * @param {object} options
 * @param {string} [options.retainMinutesSince] (e.g. 7 days ago)
 * @param {string} [options.retainHoursSince] (e.g. 90 days ago)
 */
export function pruneDispatcherMetricsBuckets({
  retainMinutesSince = null,
  retainHoursSince = null,
} = {}) {
  const db = getSqlite();
  let deletedMinutes = 0;
  let deletedHours = 0;

  if (retainMinutesSince) {
    const res = db.prepare(`
      DELETE FROM dispatcher_metrics_1m WHERE bucket_start < ?
    `).run(retainMinutesSince);
    deletedMinutes = res.changes || 0;
  }

  if (retainHoursSince) {
    const res = db.prepare(`
      DELETE FROM dispatcher_metrics_1h WHERE bucket_start < ?
    `).run(retainHoursSince);
    deletedHours = res.changes || 0;
  }

  return { deletedMinutes, deletedHours };
}

/**
 * Queries time-series timeline points for chart rendering.
 * @param {object} params
 * @param {string} params.provider
 * @param {"1h"|"24h"|"7d"} [params.range="24h"]
 * @param {string} [params.modelId]
 * @param {string} [params.connectionId]
 */
export function queryDispatcherTimeline({
  provider,
  range = "24h",
  modelId = null,
  connectionId = null,
}) {
  const db = getSqlite();
  const now = Date.now();
  let sinceMs;
  let useHourly = false;
  let groupByMinutes = 1;

  if (range === "1h") {
    sinceMs = now - 60 * 60 * 1000;
    useHourly = false;
    groupByMinutes = 1;
  } else if (range === "7d") {
    sinceMs = now - 7 * 24 * 60 * 60 * 1000;
    useHourly = true;
    groupByMinutes = 60;
  } else {
    // 24h default
    sinceMs = now - 24 * 60 * 60 * 1000;
    useHourly = false;
    groupByMinutes = 15; // group into 15-minute intervals for ~96 data points
  }

  const sinceIso = new Date(sinceMs).toISOString();
  const table = useHourly ? "dispatcher_metrics_1h" : "dispatcher_metrics_1m";

  let filterSql = "WHERE provider = ? AND bucket_start >= ?";
  const params = [provider, sinceIso];

  if (modelId) {
    filterSql += " AND model_id = ?";
    params.push(modelId);
  }
  if (connectionId) {
    filterSql += " AND connection_id = ?";
    params.push(connectionId);
  }

  const rawRows = db.prepare(`
    SELECT bucket_start,
           SUM(request_count) AS request_count,
           SUM(completed_count) AS completed_count,
           SUM(failed_count) AS failed_count,
           SUM(timed_out_count) AS timed_out_count,
           SUM(queue_wait_ms_sum) AS queue_wait_ms_sum,
           SUM(ttft_ms_sum) AS ttft_ms_sum,
           SUM(total_duration_ms_sum) AS total_duration_ms_sum,
           MAX(queue_wait_ms_max) AS queue_wait_ms_max,
           MAX(ttft_ms_max) AS ttft_ms_max,
           MAX(total_duration_ms_max) AS total_duration_ms_max,
           GROUP_CONCAT(ttft_hist_json, ';;') AS ttft_hists,
           GROUP_CONCAT(queue_hist_json, ';;') AS queue_hists
    FROM ${table}
    ${filterSql}
    GROUP BY bucket_start
    ORDER BY bucket_start ASC
  `).all(...params);

  // Group raw rows into desired interval buckets
  const points = [];
  const intervalMs = groupByMinutes * 60 * 1000;
  const grouped = new Map();

  for (const row of rawRows) {
    const timeMs = new Date(row.bucket_start).getTime();
    const intervalBucketTime = new Date(Math.floor(timeMs / intervalMs) * intervalMs).toISOString();

    if (!grouped.has(intervalBucketTime)) {
      grouped.set(intervalBucketTime, {
        timestamp: intervalBucketTime,
        requestCount: 0,
        completedCount: 0,
        failedCount: 0,
        timedOutCount: 0,
        queueWaitMsSum: 0,
        ttftMsSum: 0,
        totalDurationMsSum: 0,
        queueWaitMsMax: 0,
        ttftMsMax: 0,
        totalDurationMsMax: 0,
        ttftHist: createEmptyHistogram(),
        queueHist: createEmptyHistogram(),
      });
    }

    const g = grouped.get(intervalBucketTime);
    g.requestCount += Number(row.request_count) || 0;
    g.completedCount += Number(row.completed_count) || 0;
    g.failedCount += Number(row.failed_count) || 0;
    g.timedOutCount += Number(row.timed_out_count) || 0;
    g.queueWaitMsSum += Number(row.queue_wait_ms_sum) || 0;
    g.ttftMsSum += Number(row.ttft_ms_sum) || 0;
    g.totalDurationMsSum += Number(row.total_duration_ms_sum) || 0;
    g.queueWaitMsMax = Math.max(g.queueWaitMsMax, Number(row.queue_wait_ms_max) || 0);
    g.ttftMsMax = Math.max(g.ttftMsMax, Number(row.ttft_ms_max) || 0);
    g.totalDurationMsMax = Math.max(g.totalDurationMsMax, Number(row.total_duration_ms_max) || 0);

    if (row.ttft_hists) {
      for (const hStr of row.ttft_hists.split(";;")) {
        mergeHistograms(g.ttftHist, parseHistogram(hStr));
      }
    }
    if (row.queue_hists) {
      for (const hStr of row.queue_hists.split(";;")) {
        mergeHistograms(g.queueHist, parseHistogram(hStr));
      }
    }
  }

  for (const [timestamp, g] of grouped.entries()) {
    const completed = g.completedCount;
    const ttftPercentiles = calculatePercentiles(g.ttftHist, [50, 90, 95]);
    const queuePercentiles = calculatePercentiles(g.queueHist, [50, 95]);

    points.push({
      timestamp,
      requests: g.requestCount,
      completed,
      failed: g.failedCount,
      timedOut: g.timedOutCount,
      avgTtftMs: completed > 0 ? Math.round(g.ttftMsSum / completed) : 0,
      p50TtftMs: ttftPercentiles.p50,
      p95TtftMs: ttftPercentiles.p95,
      avgQueueWaitMs: g.requestCount > 0 ? Math.round(g.queueWaitMsSum / g.requestCount) : 0,
      p95QueueWaitMs: queuePercentiles.p95,
      avgDurationMs: completed > 0 ? Math.round(g.totalDurationMsSum / completed) : 0,
    });
  }

  return points;
}

/**
 * Returns cumulative totals and latency statistics for a provider.
 * @param {string} provider
 * @param {string} [sinceIso] (e.g. last 24h, or null for all retained history)
 */
export function queryDispatcherAggregates(provider, sinceIso = null) {
  const db = getSqlite();
  let where = "WHERE provider = ?";
  const params = [provider];

  if (sinceIso) {
    where += " AND bucket_start >= ?";
    params.push(sinceIso);
  }

  const row = db.prepare(`
    SELECT SUM(request_count) AS total_requests,
           SUM(completed_count) AS total_completed,
           SUM(failed_count) AS total_failed,
           SUM(timed_out_count) AS total_timed_out,
           SUM(queue_wait_ms_sum) AS total_queue_wait_sum,
           SUM(ttft_ms_sum) AS total_ttft_sum,
           SUM(total_duration_ms_sum) AS total_duration_sum,
           MAX(queue_wait_ms_max) AS max_queue_wait,
           MAX(ttft_ms_max) AS max_ttft,
           MAX(total_duration_ms_max) AS max_duration,
           GROUP_CONCAT(ttft_hist_json, ';;') AS ttft_hists,
           GROUP_CONCAT(queue_hist_json, ';;') AS queue_hists
    FROM dispatcher_metrics_1m
    ${where}
  `).get(...params);

  const totalRequests = Number(row?.total_requests) || 0;
  const totalCompleted = Number(row?.total_completed) || 0;
  const totalFailed = Number(row?.total_failed) || 0;
  const totalTimedOut = Number(row?.total_timed_out) || 0;

  const mergedTtft = createEmptyHistogram();
  const mergedQueue = createEmptyHistogram();

  if (row?.ttft_hists) {
    for (const hStr of row.ttft_hists.split(";;")) {
      mergeHistograms(mergedTtft, parseHistogram(hStr));
    }
  }
  if (row?.queue_hists) {
    for (const hStr of row.queue_hists.split(";;")) {
      mergeHistograms(mergedQueue, parseHistogram(hStr));
    }
  }

  const ttftPercentiles = calculatePercentiles(mergedTtft, [50, 90, 95, 99]);
  const queuePercentiles = calculatePercentiles(mergedQueue, [50, 95]);

  return {
    totalRequests,
    totalCompleted,
    totalFailed,
    totalTimedOut,
    avgTtftMs: totalCompleted > 0 ? Math.round(row.total_ttft_sum / totalCompleted) : 0,
    p50TtftMs: ttftPercentiles.p50,
    p90TtftMs: ttftPercentiles.p90,
    p95TtftMs: ttftPercentiles.p95,
    p99TtftMs: ttftPercentiles.p99,
    maxTtftMs: Number(row?.max_ttft) || 0,
    avgQueueWaitMs: totalRequests > 0 ? Math.round(row.total_queue_wait_sum / totalRequests) : 0,
    p50QueueWaitMs: queuePercentiles.p50,
    p95QueueWaitMs: queuePercentiles.p95,
    maxQueueWaitMs: Number(row?.max_queue_wait) || 0,
    avgDurationMs: totalCompleted > 0 ? Math.round(row.total_duration_sum / totalCompleted) : 0,
    maxDurationMs: Number(row?.max_duration) || 0,
  };
}
