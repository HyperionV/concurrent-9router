import { getMetricsDb } from "@/lib/sqlite/dispatcherMetrics/db.js";

/**
 * Adds a batch of 1-minute buckets in one transaction. A bucket that already
 * exists (a later flush within the same minute) has its counters summed and
 * its latency histograms merged, so no sample is lost.
 * @param {Array<object>} buckets rows shaped like metricsAggregator buckets
 */
export function upsertDispatcherMinuteBuckets(buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return;
  const db = getMetricsDb();

  const stmt = db.prepare(`
    INSERT INTO dispatcher_metrics_1m (
      provider, bucket_start, model_id, connection_id,
      request_count, completed_count, failed_count, timed_out_count, cancelled_count,
      queue_wait_ms_sum, ttft_ms_sum, total_duration_ms_sum,
      queue_wait_ms_max, ttft_ms_max, total_duration_ms_max,
      ttft_hist_json, queue_hist_json, duration_hist_json
    ) VALUES (
      @provider, @bucketStart, @modelId, @connectionId,
      @requestCount, @completedCount, @failedCount, @timedOutCount, @cancelledCount,
      @queueWaitMsSum, @ttftMsSum, @totalDurationMsSum,
      @queueWaitMsMax, @ttftMsMax, @totalDurationMsMax,
      @ttftHistJson, @queueHistJson, @durationHistJson
    )
    ON CONFLICT(provider, bucket_start, model_id, connection_id) DO UPDATE SET
      request_count = request_count + excluded.request_count,
      completed_count = completed_count + excluded.completed_count,
      failed_count = failed_count + excluded.failed_count,
      timed_out_count = timed_out_count + excluded.timed_out_count,
      cancelled_count = cancelled_count + excluded.cancelled_count,
      queue_wait_ms_sum = queue_wait_ms_sum + excluded.queue_wait_ms_sum,
      ttft_ms_sum = ttft_ms_sum + excluded.ttft_ms_sum,
      total_duration_ms_sum = total_duration_ms_sum + excluded.total_duration_ms_sum,
      queue_wait_ms_max = MAX(queue_wait_ms_max, excluded.queue_wait_ms_max),
      ttft_ms_max = MAX(ttft_ms_max, excluded.ttft_ms_max),
      total_duration_ms_max = MAX(total_duration_ms_max, excluded.total_duration_ms_max),
      ttft_hist_json = hist_merge(ttft_hist_json, excluded.ttft_hist_json),
      queue_hist_json = hist_merge(queue_hist_json, excluded.queue_hist_json),
      duration_hist_json = hist_merge(duration_hist_json, excluded.duration_hist_json)
  `);

  db.transaction((rows) => {
    for (const row of rows) {
      stmt.run({
        provider: row.provider,
        bucketStart: row.bucketStart,
        modelId: row.modelId,
        connectionId: row.connectionId,
        requestCount: row.requestCount,
        completedCount: row.completedCount,
        failedCount: row.failedCount,
        timedOutCount: row.timedOutCount,
        cancelledCount: row.cancelledCount,
        queueWaitMsSum: row.queueWaitMsSum,
        ttftMsSum: row.ttftMsSum,
        totalDurationMsSum: row.totalDurationMsSum,
        queueWaitMsMax: row.queueWaitMsMax,
        ttftMsMax: row.ttftMsMax,
        totalDurationMsMax: row.totalDurationMsMax,
        ttftHistJson: JSON.stringify(row.ttftHist),
        queueHistJson: JSON.stringify(row.queueHist),
        durationHistJson: JSON.stringify(row.durationHist),
      });
    }
  })(buckets);
}

/**
 * Deletes buckets older than the retention cutoffs.
 * @param {{retainMinutesSince?: string|null, retainHoursSince?: string|null}} cutoffs
 */
export function pruneDispatcherMetricsBuckets({
  retainMinutesSince = null,
  retainHoursSince = null,
} = {}) {
  const db = getMetricsDb();
  const deletedMinutes = retainMinutesSince
    ? db.prepare("DELETE FROM dispatcher_metrics_1m WHERE bucket_start < ?").run(retainMinutesSince).changes
    : 0;
  const deletedHours = retainHoursSince
    ? db.prepare("DELETE FROM dispatcher_metrics_1h WHERE bucket_start < ?").run(retainHoursSince).changes
    : 0;
  return { deletedMinutes, deletedHours };
}
