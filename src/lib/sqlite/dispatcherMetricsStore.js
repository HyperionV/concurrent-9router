import { getSqlite } from "@/lib/sqlite/runtime.js";
import {
  createEmptyHistogram,
  recordLatency,
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

  // Query token and usage data from usage_events for the same intervals
  const intervalSec = groupByMinutes * 60;
  let usageFilterSql = "WHERE provider = ? AND timestamp >= ?";
  const usageParams = [provider, sinceIso];
  if (modelId) {
    usageFilterSql += " AND model_id = ?";
    usageParams.push(modelId);
  }
  if (connectionId) {
    usageFilterSql += " AND connection_id = ?";
    usageParams.push(connectionId);
  }

  const usageRows = db.prepare(`
    SELECT 
      strftime('%Y-%m-%dT%H:%M:00.000Z', datetime((strftime('%s', timestamp) / ${intervalSec}) * ${intervalSec}, 'unixepoch')) AS bucket,
      COUNT(1) as requests,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens,
      SUM(cached_tokens) as cached_tokens
    FROM usage_events
    ${usageFilterSql}
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(...usageParams);

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
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        usageRequests: 0,
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

  // Merge usage_events tokens into grouped buckets
  for (const urow of usageRows) {
    const bucketTime = urow.bucket;
    if (!grouped.has(bucketTime)) {
      grouped.set(bucketTime, {
        timestamp: bucketTime,
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
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        usageRequests: 0,
      });
    }
    const g = grouped.get(bucketTime);
    g.promptTokens += Number(urow.prompt_tokens) || 0;
    g.completionTokens += Number(urow.completion_tokens) || 0;
    g.cachedTokens += Number(urow.cached_tokens) || 0;
    g.usageRequests += Number(urow.requests) || 0;
  }

  // Sort grouped timestamps chronologically
  const sortedTimestamps = Array.from(grouped.keys()).sort();

  for (const timestamp of sortedTimestamps) {
    const g = grouped.get(timestamp);
    const reqs = Math.max(g.requestCount, g.usageRequests || 0);
    const completed = g.completedCount > 0 ? g.completedCount : (g.requestCount === 0 ? reqs : 0);
    const ttftPercentiles = calculatePercentiles(g.ttftHist, [50, 90, 95]);
    const queuePercentiles = calculatePercentiles(g.queueHist, [50, 95]);

    const promptTokens = g.promptTokens || 0;
    const completionTokens = g.completionTokens || 0;
    const cachedTokens = g.cachedTokens || 0;
    const totalTokens = promptTokens + completionTokens;
    const cacheHitRate = (cachedTokens + promptTokens > 0)
      ? Number(((cachedTokens / (promptTokens + cachedTokens)) * 100).toFixed(1))
      : 0;

    const avgTtftMs = completed > 0 && g.ttftMsSum > 0 ? Math.round(g.ttftMsSum / completed) : 0;
    const avgQueueWaitMs = reqs > 0 && g.queueWaitMsSum > 0 ? Math.round(g.queueWaitMsSum / reqs) : 0;
    const avgDurationMs = completed > 0 && g.totalDurationMsSum > 0 ? Math.round(g.totalDurationMsSum / completed) : 0;
    const decodeDurationMs = Math.max(0, avgDurationMs - avgTtftMs - avgQueueWaitMs);

    // Generation velocity: tokens per second during stream decode
    const tps = decodeDurationMs > 0 && completionTokens > 0
      ? Number(((completionTokens / (completed || 1)) / (decodeDurationMs / 1000)).toFixed(1))
      : 0;
    const tpsOverall = Number((completionTokens / (groupByMinutes * 60)).toFixed(1));

    points.push({
      timestamp,
      requests: reqs,
      completed,
      failed: g.failedCount,
      timedOut: g.timedOutCount,
      promptTokens,
      completionTokens,
      cachedTokens,
      totalTokens,
      cacheHitRate,
      tps,
      tpsOverall,
      avgTtftMs,
      p50TtftMs: ttftPercentiles.p50,
      p95TtftMs: ttftPercentiles.p95,
      avgQueueWaitMs,
      p95QueueWaitMs: queuePercentiles.p95,
      avgDurationMs,
      decodeDurationMs,
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

  let usageWhere = "WHERE provider = ?";
  const usageParams = [provider];
  if (sinceIso) {
    usageWhere += " AND timestamp >= ?";
    usageParams.push(sinceIso);
  }
  const usageRow = db.prepare(`
    SELECT COUNT(1) AS usage_count,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(cached_tokens) AS cached_tokens
    FROM usage_events
    ${usageWhere}
  `).get(...usageParams);

  const promptTokens = Number(usageRow?.prompt_tokens) || 0;
  const completionTokens = Number(usageRow?.completion_tokens) || 0;
  const cachedTokens = Number(usageRow?.cached_tokens) || 0;
  const totalTokens = promptTokens + completionTokens;
  const cacheHitRate = (cachedTokens + promptTokens > 0)
    ? Number(((cachedTokens / (promptTokens + cachedTokens)) * 100).toFixed(1))
    : 0;
  const effectiveTotalRequests = Math.max(totalRequests, Number(usageRow?.usage_count) || 0);

  return {
    totalRequests: effectiveTotalRequests,
    totalCompleted,
    totalFailed,
    totalTimedOut,
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens,
    cacheHitRate,
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

/**
 * Queries the absolute latest active timestamp per connection across attempts and metrics buckets.
 * @param {string} provider
 * @returns {Record<string, string>} map of connectionId -> ISO timestamp
 */
export function queryDispatcherLastActiveByConnection(provider) {
  const db = getSqlite();
  const map = {};

  const attemptRows = db.prepare(`
    SELECT connection_id,
           MAX(COALESCE(finished_at, last_progress_at, first_progress_at, stream_started_at, connect_started_at, leased_at, queue_entered_at)) AS last_active_at
    FROM dispatch_attempts
    WHERE provider = ? AND connection_id IS NOT NULL
    GROUP BY connection_id
  `).all(provider);

  for (const r of attemptRows) {
    if (r.connection_id && r.last_active_at) {
      map[r.connection_id] = r.last_active_at;
    }
  }

  const bucketRows = db.prepare(`
    SELECT connection_id, MAX(bucket_start) AS last_bucket
    FROM dispatcher_metrics_1m
    WHERE provider = ? AND connection_id IS NOT NULL AND connection_id != 'all'
    GROUP BY connection_id
  `).all(provider);

  for (const r of bucketRows) {
    if (r.connection_id && r.last_bucket) {
      if (!map[r.connection_id] || r.last_bucket > map[r.connection_id]) {
        map[r.connection_id] = r.last_bucket;
      }
    }
  }

  return map;
}

/**
 * Queries durable connection statistics for a provider over a given range or cutoff.
 * @param {object} params
 * @param {string} params.provider
 * @param {"1h"|"24h"|"7d"} [params.range="24h"]
 * @param {string} [params.sinceIso]
 * @returns {Record<string, object>} map of connectionId -> connection health metrics
 */
export function queryDispatcherConnectionStats({
  provider,
  range = "24h",
  sinceIso = null,
}) {
  const db = getSqlite();
  const now = Date.now();
  let effectiveSinceIso = sinceIso;
  if (!effectiveSinceIso) {
    let sinceMs = now - 24 * 60 * 60 * 1000;
    if (range === "1h") sinceMs = now - 60 * 60 * 1000;
    else if (range === "7d") sinceMs = now - 7 * 24 * 60 * 60 * 1000;
    effectiveSinceIso = new Date(sinceMs).toISOString();
  }

  const lastActiveMap = queryDispatcherLastActiveByConnection(provider);

  const attempts = db.prepare(`
    SELECT connection_id, state, terminal_reason,
           queue_entered_at, leased_at, connect_started_at, first_progress_at, finished_at
    FROM dispatch_attempts
    WHERE provider = ?
      AND queue_entered_at >= ?
      AND connection_id IS NOT NULL
  `).all(provider, effectiveSinceIso);

  const statsByConn = {};

  for (const att of attempts) {
    const cid = att.connection_id;
    if (!statsByConn[cid]) {
      statsByConn[cid] = {
        recentAttempts: 0,
        recentTerminalReasonCounts: {},
        lastAttemptAt: lastActiveMap[cid] || null,
        ttftSum: 0,
        ttftCount: 0,
        queueSum: 0,
        queueCount: 0,
        ttftHist: createEmptyHistogram(),
      };
    }
    const s = statsByConn[cid];
    s.recentAttempts += 1;

    if (att.state !== "leased" && att.state !== "connecting" && att.state !== "streaming") {
      const reason = att.terminal_reason || "unknown";
      s.recentTerminalReasonCounts[reason] = (s.recentTerminalReasonCounts[reason] || 0) + 1;
    }

    const cand = att.finished_at || att.first_progress_at || att.queue_entered_at;
    if (cand && (!s.lastAttemptAt || cand > s.lastAttemptAt)) {
      s.lastAttemptAt = cand;
    }

    if (att.leased_at && att.queue_entered_at) {
      const q = Math.max(0, new Date(att.leased_at).getTime() - new Date(att.queue_entered_at).getTime());
      if (Number.isFinite(q)) {
        s.queueSum += q;
        s.queueCount += 1;
      }
    }

    if (att.first_progress_at && att.connect_started_at) {
      const t = Math.max(0, new Date(att.first_progress_at).getTime() - new Date(att.connect_started_at).getTime());
      if (Number.isFinite(t)) {
        s.ttftSum += t;
        s.ttftCount += 1;
        recordLatency(s.ttftHist, t);
      }
    }
  }

  const table = range === "7d" ? "dispatcher_metrics_1h" : "dispatcher_metrics_1m";
  const metricRows = db.prepare(`
    SELECT connection_id,
           SUM(request_count) AS request_count,
           SUM(completed_count) AS completed_count,
           SUM(failed_count) AS failed_count,
           SUM(timed_out_count) AS timed_out_count,
           SUM(queue_wait_ms_sum) AS queue_wait_sum,
           SUM(ttft_ms_sum) AS ttft_sum,
           GROUP_CONCAT(ttft_hist_json, ';;') AS ttft_hists
    FROM ${table}
    WHERE provider = ?
      AND bucket_start >= ?
      AND connection_id IS NOT NULL
      AND connection_id != 'all'
    GROUP BY connection_id
  `).all(provider, effectiveSinceIso);

  for (const m of metricRows) {
    const cid = m.connection_id;
    if (!statsByConn[cid]) {
      const ttftHist = createEmptyHistogram();
      if (m.ttft_hists) {
        for (const hStr of m.ttft_hists.split(";;")) {
          mergeHistograms(ttftHist, parseHistogram(hStr));
        }
      }
      const completed = Number(m.completed_count) || 0;
      const reqs = Number(m.request_count) || 0;
      statsByConn[cid] = {
        recentAttempts: reqs,
        recentTerminalReasonCounts: {},
        lastAttemptAt: lastActiveMap[cid] || null,
        avgTtftMs: completed > 0 ? Math.round(Number(m.ttft_sum) / completed) : 0,
        p95TtftMs: calculatePercentiles(ttftHist, [95]).p95,
        avgQueueWaitMs: reqs > 0 ? Math.round(Number(m.queue_wait_sum) / reqs) : 0,
      };
    }
  }

  const result = {};
  for (const [cid, s] of Object.entries(statsByConn)) {
    result[cid] = {
      recentAttempts: s.recentAttempts,
      recentTerminalReasonCounts: s.recentTerminalReasonCounts,
      lastAttemptAt: s.lastAttemptAt || lastActiveMap[cid] || null,
      avgTtftMs: s.avgTtftMs !== undefined ? s.avgTtftMs : (s.ttftCount > 0 ? Math.round(s.ttftSum / s.ttftCount) : 0),
      p95TtftMs: s.p95TtftMs !== undefined ? s.p95TtftMs : calculatePercentiles(s.ttftHist, [95]).p95,
      avgQueueWaitMs: s.avgQueueWaitMs !== undefined ? s.avgQueueWaitMs : (s.queueCount > 0 ? Math.round(s.queueSum / s.queueCount) : 0),
    };
  }

  for (const [cid, lastActive] of Object.entries(lastActiveMap)) {
    if (!result[cid]) {
      result[cid] = {
        recentAttempts: 0,
        recentTerminalReasonCounts: {},
        lastAttemptAt: lastActive,
        avgTtftMs: 0,
        p95TtftMs: 0,
        avgQueueWaitMs: 0,
      };
    }
  }

  // Merge token volumes and cache hit rate from usage_events
  const usageConns = db.prepare(`
    SELECT connection_id,
           COUNT(1) AS request_count,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(cached_tokens) AS cached_tokens
    FROM usage_events
    WHERE provider = ? AND timestamp >= ? AND connection_id IS NOT NULL
    GROUP BY connection_id
  `).all(provider, effectiveSinceIso);

  for (const u of usageConns) {
    const cid = u.connection_id;
    const promptTokens = Number(u.prompt_tokens) || 0;
    const completionTokens = Number(u.completion_tokens) || 0;
    const cachedTokens = Number(u.cached_tokens) || 0;
    const totalTokens = promptTokens + completionTokens;
    const cacheHitRate = (cachedTokens + promptTokens > 0)
      ? Number(((cachedTokens / (promptTokens + cachedTokens)) * 100).toFixed(1))
      : 0;

    if (!result[cid]) {
      result[cid] = {
        recentAttempts: Number(u.request_count) || 0,
        recentTerminalReasonCounts: {},
        lastAttemptAt: lastActiveMap[cid] || null,
        avgTtftMs: 0,
        p95TtftMs: 0,
        avgQueueWaitMs: 0,
        promptTokens,
        completionTokens,
        cachedTokens,
        totalTokens,
        cacheHitRate,
      };
    } else {
      result[cid].promptTokens = promptTokens;
      result[cid].completionTokens = completionTokens;
      result[cid].cachedTokens = cachedTokens;
      result[cid].totalTokens = totalTokens;
      result[cid].cacheHitRate = cacheHitRate;
      if (result[cid].recentAttempts === 0 && u.request_count > 0) {
        result[cid].recentAttempts = Number(u.request_count) || 0;
      }
    }
  }

  return result;
}

/**
 * Queries durable model statistics for a provider over a given range or cutoff.
 * @param {object} params
 * @param {string} params.provider
 * @param {"1h"|"24h"|"7d"} [params.range="24h"]
 * @param {string} [params.sinceIso]
 * @param {Array<object>} [params.queuedRequests=[]]
 * @param {Array<object>} [params.activeAttempts=[]]
 * @returns {Array<object>} list of model statistics
 */
export function queryDispatcherModelStats({
  provider,
  range = "24h",
  sinceIso = null,
  queuedRequests = [],
  activeAttempts = [],
}) {
  const db = getSqlite();
  const now = Date.now();
  let effectiveSinceIso = sinceIso;
  if (!effectiveSinceIso) {
    let sinceMs = now - 24 * 60 * 60 * 1000;
    if (range === "1h") sinceMs = now - 60 * 60 * 1000;
    else if (range === "7d") sinceMs = now - 7 * 24 * 60 * 60 * 1000;
    effectiveSinceIso = new Date(sinceMs).toISOString();
  }

  const byModel = new Map();

  function ensureModel(modelId) {
    const key = modelId || "unknown";
    if (!byModel.has(key)) {
      byModel.set(key, {
        modelId: key,
        queued: 0,
        active: 0,
        completed: 0,
        failed: 0,
        timedOut: 0,
        cancelled: 0,
        reconciled: 0,
        total: 0,
        ttftSum: 0,
        ttftCount: 0,
        queueSum: 0,
        queueCount: 0,
        ttftHist: createEmptyHistogram(),
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
      });
    }
    return byModel.get(key);
  }

  for (const req of queuedRequests) {
    const m = ensureModel(req.modelId);
    m.queued += 1;
    m.total += 1;
  }

  for (const att of activeAttempts) {
    const m = ensureModel(att.modelId);
    m.active += 1;
    m.total += 1;
  }

  const attempts = db.prepare(`
    SELECT model_id, state,
           queue_entered_at, leased_at, connect_started_at, first_progress_at, finished_at
    FROM dispatch_attempts
    WHERE provider = ?
      AND queue_entered_at >= ?
  `).all(provider, effectiveSinceIso);

  for (const att of attempts) {
    const m = ensureModel(att.model_id || att.modelId);
    if (att.state === "completed") m.completed += 1;
    else if (att.state === "failed") m.failed += 1;
    else if (att.state === "timed_out") m.timedOut += 1;
    else if (att.state === "cancelled") m.cancelled += 1;
    else if (att.state === "reconciled") m.reconciled += 1;
    m.total += 1;

    if (att.leased_at && att.queue_entered_at) {
      const q = Math.max(0, new Date(att.leased_at).getTime() - new Date(att.queue_entered_at).getTime());
      if (Number.isFinite(q)) {
        m.queueSum += q;
        m.queueCount += 1;
      }
    }

    if (att.first_progress_at && att.connect_started_at) {
      const t = Math.max(0, new Date(att.first_progress_at).getTime() - new Date(att.connect_started_at).getTime());
      if (Number.isFinite(t)) {
        m.ttftSum += t;
        m.ttftCount += 1;
        recordLatency(m.ttftHist, t);
      }
    }
  }

  const table = range === "7d" ? "dispatcher_metrics_1h" : "dispatcher_metrics_1m";
  const metricRows = db.prepare(`
    SELECT model_id,
           SUM(request_count) AS request_count,
           SUM(completed_count) AS completed_count,
           SUM(failed_count) AS failed_count,
           SUM(timed_out_count) AS timed_out_count,
           SUM(queue_wait_ms_sum) AS queue_wait_sum,
           SUM(ttft_ms_sum) AS ttft_sum,
           GROUP_CONCAT(ttft_hist_json, ';;') AS ttft_hists
    FROM ${table}
    WHERE provider = ?
      AND bucket_start >= ?
      AND model_id IS NOT NULL
      AND model_id != 'all'
    GROUP BY model_id
  `).all(provider, effectiveSinceIso);

  for (const row of metricRows) {
    if (!byModel.has(row.model_id)) {
      const m = ensureModel(row.model_id);
      m.completed = Number(row.completed_count) || 0;
      m.failed = Number(row.failed_count) || 0;
      m.timedOut = Number(row.timed_out_count) || 0;
      m.total = Number(row.request_count) || 0;
      m.ttftSum = Number(row.ttft_sum) || 0;
      m.ttftCount = m.completed;
      m.queueSum = Number(row.queue_wait_sum) || 0;
      m.queueCount = m.total;
      if (row.ttft_hists) {
        for (const hStr of row.ttft_hists.split(";;")) {
          mergeHistograms(m.ttftHist, parseHistogram(hStr));
        }
      }
    }
  }

  // Merge token volumes and cache hit rate from usage_events
  const usageModels = db.prepare(`
    SELECT model_id,
           COUNT(1) AS request_count,
           SUM(prompt_tokens) AS prompt_tokens,
           SUM(completion_tokens) AS completion_tokens,
           SUM(cached_tokens) AS cached_tokens
    FROM usage_events
    WHERE provider = ? AND timestamp >= ? AND model_id IS NOT NULL
    GROUP BY model_id
  `).all(provider, effectiveSinceIso);

  for (const u of usageModels) {
    const m = ensureModel(u.model_id);
    m.promptTokens = (m.promptTokens || 0) + (Number(u.prompt_tokens) || 0);
    m.completionTokens = (m.completionTokens || 0) + (Number(u.completion_tokens) || 0);
    m.cachedTokens = (m.cachedTokens || 0) + (Number(u.cached_tokens) || 0);
    if (m.total === 0 && u.request_count > 0) {
      m.total = Number(u.request_count) || 0;
      m.completed = Number(u.request_count) || 0;
    }
  }

  return [...byModel.values()]
    .map((m) => {
      const promptTokens = m.promptTokens || 0;
      const completionTokens = m.completionTokens || 0;
      const cachedTokens = m.cachedTokens || 0;
      const totalTokens = promptTokens + completionTokens;
      const cacheHitRate = (cachedTokens + promptTokens > 0)
        ? Number(((cachedTokens / (promptTokens + cachedTokens)) * 100).toFixed(1))
        : 0;

      return {
        modelId: m.modelId,
        queued: m.queued,
        active: m.active,
        completed: m.completed,
        failed: m.failed,
        timedOut: m.timedOut,
        cancelled: m.cancelled,
        reconciled: m.reconciled,
        total: m.total,
        promptTokens,
        completionTokens,
        cachedTokens,
        totalTokens,
        cacheHitRate,
        avgTtftMs: m.ttftCount > 0 ? Math.round(m.ttftSum / m.ttftCount) : 0,
        p95TtftMs: calculatePercentiles(m.ttftHist, [95]).p95,
        avgQueueWaitMs: m.queueCount > 0 ? Math.round(m.queueSum / m.queueCount) : 0,
      };
    })
    .sort((a, b) => {
      const totalDiff = b.total - a.total;
      if (totalDiff !== 0) return totalDiff;
      return a.modelId.localeCompare(b.modelId);
    });
}
