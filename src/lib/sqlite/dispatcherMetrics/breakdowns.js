import { getMetricsDb } from "@/lib/sqlite/dispatcherMetrics/db.js";
import {
  EMPTY_BUCKET_ROW,
  indexBy,
  summarizeBuckets,
  summarizeUsage,
} from "@/lib/sqlite/dispatcherMetrics/derive.js";
import {
  USAGE_WINDOW_INDEX,
  selectBucketRows,
  selectUsageRows,
} from "@/lib/sqlite/dispatcherMetrics/source.js";

/**
 * Per-model and per-account statistics for one window. Both read the same
 * window as the timeline and totals, so every number on the dashboard covers
 * the same period.
 */

// Buckets record attempts without a model or account under this key.
const UNATTRIBUTED_KEY = "all";

function breakdown(db, window, provider, key) {
  const buckets = indexBy(selectBucketRows(db, window, { provider, groupBy: [key] }), key);
  const usage = indexBy(selectUsageRows(db, window, { provider, groupBy: [key] }), key);
  const ids = new Set([...buckets.keys(), ...usage.keys()]);
  ids.delete(null);
  return [...ids].map((id) => ({
    id: id === UNATTRIBUTED_KEY ? "unattributed" : id,
    dispatch: summarizeBuckets(buckets.get(id) || EMPTY_BUCKET_ROW),
    traffic: summarizeUsage(usage.get(id) || EMPTY_BUCKET_ROW),
  }));
}

/**
 * @param {{provider: string, window: object}} query
 * @returns {Array<{modelId: string, dispatch: object, traffic: object}>}
 *   busiest first
 */
export function queryModelBreakdown({ provider, window }) {
  const db = getMetricsDb();
  return breakdown(db, window, provider, "model")
    .map(({ id, dispatch, traffic }) => ({ modelId: id, dispatch, traffic }))
    .sort(
      (a, b) =>
        b.traffic.requests + b.dispatch.attempts - (a.traffic.requests + a.dispatch.attempts) ||
        a.modelId.localeCompare(b.modelId),
    );
}

/**
 * @param {{provider: string, window: object, connectionIds: string[]}} query
 * @returns {Record<string, {dispatch: object, traffic: object, models: Array, lastActiveAt: string|null}>}
 *   keyed by connection id; includes every id in `connectionIds`
 */
export function queryAccountBreakdown({ provider, window, connectionIds }) {
  const db = getMetricsDb();
  const byAccount = {};
  for (const { id, dispatch, traffic } of breakdown(db, window, provider, "connection")) {
    byAccount[id] = { dispatch, traffic, models: [], lastActiveAt: null };
  }
  for (const id of connectionIds) {
    byAccount[id] ||= {
      dispatch: summarizeBuckets(EMPTY_BUCKET_ROW),
      traffic: summarizeUsage(EMPTY_BUCKET_ROW),
      models: [],
      lastActiveAt: null,
    };
  }

  const modelRows = db
    .prepare(
      `SELECT connection_id, model_id, COUNT(1) AS requests,
              SUM(prompt_tokens + completion_tokens) AS total_tokens
       FROM usage_events ${USAGE_WINDOW_INDEX}
       WHERE provider = ? AND timestamp >= ? AND timestamp < ? AND connection_id IS NOT NULL
       GROUP BY connection_id, model_id
       ORDER BY total_tokens DESC`,
    )
    .all(provider, window.sinceIso, window.untilIso);
  for (const row of modelRows) {
    byAccount[row.connection_id]?.models.push({
      modelId: row.model_id || "unknown",
      requests: Number(row.requests) || 0,
      totalTokens: Number(row.total_tokens) || 0,
    });
  }

  // Indexed point lookups per account: (connection_id, timestamp) on the
  // usage log and (connection_id, state) on attempts.
  const lastUsage = db.prepare(
    "SELECT MAX(timestamp) AS at FROM usage_events WHERE connection_id = ?",
  );
  const lastAttempt = db.prepare(
    `SELECT MAX(COALESCE(finished_at, last_progress_at, leased_at)) AS at
     FROM dispatch_attempts WHERE connection_id = ?`,
  );
  for (const [id, account] of Object.entries(byAccount)) {
    const usageAt = lastUsage.get(id)?.at || null;
    const attemptAt = lastAttempt.get(id)?.at || null;
    account.lastActiveAt = usageAt && attemptAt ? (usageAt > attemptAt ? usageAt : attemptAt) : usageAt || attemptAt;
  }
  return byAccount;
}
