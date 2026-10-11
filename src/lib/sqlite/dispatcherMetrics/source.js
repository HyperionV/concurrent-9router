import { stepKeySql } from "@/lib/sqlite/dispatcherMetrics/window.js";

/**
 * Reads the raw inputs of a metrics window: summed dispatcher buckets (from
 * the tables the window names) and token totals from the usage log. Callers
 * pass a connection from getMetricsDb(), which provides hist_sum.
 */

const GROUP_COLUMNS = {
  model: "model_id",
  connection: "connection_id",
};

const BUCKET_SUMS = `
  SUM(request_count) AS request_count,
  SUM(completed_count) AS completed_count,
  SUM(failed_count) AS failed_count,
  SUM(timed_out_count) AS timed_out_count,
  SUM(cancelled_count) AS cancelled_count,
  SUM(queue_wait_ms_sum) AS queue_wait_ms_sum,
  SUM(ttft_ms_sum) AS ttft_ms_sum,
  SUM(total_duration_ms_sum) AS total_duration_ms_sum,
  MAX(queue_wait_ms_max) AS queue_wait_ms_max,
  MAX(ttft_ms_max) AS ttft_ms_max,
  MAX(total_duration_ms_max) AS total_duration_ms_max,
  hist_sum(ttft_hist_json) AS ttft_hist_json,
  hist_sum(queue_hist_json) AS queue_hist_json,
  hist_sum(duration_hist_json) AS duration_hist_json
`;

function groupSelect(groupBy, timeColumn, stepMs) {
  return groupBy.map((key) => {
    if (key === "step") return `${stepKeySql(timeColumn, stepMs)} AS step`;
    if (!GROUP_COLUMNS[key]) throw new Error(`unknown metrics group "${key}"`);
    return `${GROUP_COLUMNS[key]} AS ${key}`;
  });
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {ReturnType<import("./window.js").resolveMetricsWindow>} window
 * @param {{provider: string, groupBy?: Array<"step"|"model"|"connection">}} query
 * @returns {Array<object>} one row per group; no rows when the window is empty
 */
export function selectBucketRows(db, window, { provider, groupBy = [] }) {
  const parts = [];
  const params = [];
  for (const [table, span] of [
    ["dispatcher_metrics_1h", window.hourly],
    ["dispatcher_metrics_1m", window.minute],
  ]) {
    if (!span) continue;
    parts.push(
      `SELECT * FROM ${table} WHERE provider = ? AND bucket_start >= ? AND bucket_start < ?`,
    );
    params.push(provider, span.fromIso, span.toIso);
  }
  if (parts.length === 0) return [];

  const select = [...groupSelect(groupBy, "bucket_start", window.stepMs), BUCKET_SUMS];
  // An ungrouped aggregate over zero rows still yields one all-NULL row.
  const groupSql = groupBy.length
    ? `GROUP BY ${groupBy.join(", ")}`
    : "HAVING COUNT(1) > 0";
  return db
    .prepare(
      `SELECT ${select.join(",\n")} FROM (${parts.join(" UNION ALL ")}) ${groupSql}`,
    )
    .all(...params);
}

/**
 * Token totals for every request the provider served in the window, whether
 * or not the dispatcher routed it. Bounded by (provider, timestamp), so it
 * reads only the window's rows of the usage log.
 */
export function selectUsageRows(db, window, { provider, groupBy = [] }) {
  const select = [
    ...groupSelect(groupBy, "timestamp", window.stepMs),
    "COUNT(1) AS request_count",
    "SUM(prompt_tokens) AS prompt_tokens",
    "SUM(completion_tokens) AS completion_tokens",
    "SUM(cached_tokens) AS cached_tokens",
    "SUM(cost) AS cost",
  ];
  const groupSql = groupBy.length
    ? `GROUP BY ${groupBy.join(", ")}`
    : "HAVING COUNT(1) > 0";
  return db
    .prepare(
      `SELECT ${select.join(",\n")} FROM usage_events ${USAGE_WINDOW_INDEX}
       WHERE provider = ? AND timestamp >= ? AND timestamp < ?
       ${groupSql}`,
    )
    .all(provider, window.sinceIso, window.untilIso);
}

/**
 * Grouping by account or model tempts the planner into the
 * (provider, connection_id, ...) indexes, which walk the provider's whole
 * usage history (~0.7s on 280k rows). Windows are always bounded by time, so
 * the (provider, timestamp) index is the right one.
 */
export const USAGE_WINDOW_INDEX = "INDEXED BY usage_events_provider_idx";

export function readRolledUntil(db) {
  return (
    db
      .prepare("SELECT rolled_until FROM dispatcher_metrics_rollup_state WHERE id = 1")
      .get()?.rolled_until || null
  );
}
