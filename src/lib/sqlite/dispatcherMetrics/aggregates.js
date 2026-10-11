import { getMetricsDb } from "@/lib/sqlite/dispatcherMetrics/db.js";
import {
  EMPTY_BUCKET_ROW,
  summarizeBuckets,
  summarizeUsage,
} from "@/lib/sqlite/dispatcherMetrics/derive.js";
import {
  selectBucketRows,
  selectUsageRows,
} from "@/lib/sqlite/dispatcherMetrics/source.js";

/**
 * Totals for one window: dispatcher outcomes and latency (attempts the
 * dispatcher routed) and provider traffic (every request in the usage log).
 * @param {{provider: string, window: ReturnType<import("./window.js").resolveMetricsWindow>}} query
 */
export function queryDispatcherAggregates({ provider, window }) {
  const db = getMetricsDb();
  const [buckets = EMPTY_BUCKET_ROW] = selectBucketRows(db, window, { provider });
  const [usage = EMPTY_BUCKET_ROW] = selectUsageRows(db, window, { provider });
  return {
    sinceIso: window.sinceIso,
    untilIso: window.untilIso,
    dispatch: summarizeBuckets(buckets),
    traffic: summarizeUsage(usage),
  };
}
