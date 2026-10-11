import { getMetricsDb } from "@/lib/sqlite/dispatcherMetrics/db.js";
import {
  EMPTY_BUCKET_ROW,
  indexBy,
  summarizeBuckets,
  summarizeUsage,
} from "@/lib/sqlite/dispatcherMetrics/derive.js";
import {
  selectBucketRows,
  selectUsageRows,
} from "@/lib/sqlite/dispatcherMetrics/source.js";
import { MINUTE_MS, listStepStarts } from "@/lib/sqlite/dispatcherMetrics/window.js";

/**
 * One chart point per step of the window, oldest first, with empty steps
 * filled with zeros so the time axis is continuous.
 * @param {{provider: string, window: ReturnType<import("./window.js").resolveMetricsWindow>}} query
 */
export function queryDispatcherTimeline({ provider, window }) {
  const db = getMetricsDb();
  const buckets = indexBy(selectBucketRows(db, window, { provider, groupBy: ["step"] }), "step");
  const usage = indexBy(selectUsageRows(db, window, { provider, groupBy: ["step"] }), "step");
  const stepMinutes = window.stepMs / MINUTE_MS;

  return listStepStarts(window).map((step) => {
    const dispatch = summarizeBuckets(buckets.get(step) || EMPTY_BUCKET_ROW);
    const traffic = summarizeUsage(usage.get(step) || EMPTY_BUCKET_ROW);
    return {
      timestamp: step,
      attempts: dispatch.attempts,
      completed: dispatch.completed,
      failed: dispatch.failed,
      timedOut: dispatch.timedOut,
      cancelled: dispatch.cancelled,
      successRate: dispatch.successRate,
      ttftAvgMs: dispatch.ttft.avgMs,
      ttftP50Ms: dispatch.ttft.p50Ms,
      ttftP95Ms: dispatch.ttft.p95Ms,
      queueWaitAvgMs: dispatch.queueWait.avgMs,
      queueWaitP95Ms: dispatch.queueWait.p95Ms,
      durationAvgMs: dispatch.duration.avgMs,
      durationP95Ms: dispatch.duration.p95Ms,
      requests: traffic.requests,
      promptTokens: traffic.promptTokens,
      completionTokens: traffic.completionTokens,
      cachedTokens: traffic.cachedTokens,
      cacheHitRate: traffic.cacheHitRate,
      outputTokensPerMinute: Math.round(traffic.completionTokens / stepMinutes),
      cost: traffic.cost,
    };
  });
}
