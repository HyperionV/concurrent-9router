import { getMetricsDb } from "@/lib/sqlite/dispatcherMetrics/db.js";
import { readRolledUntil } from "@/lib/sqlite/dispatcherMetrics/source.js";
import { HOUR_MS, stepKeySql } from "@/lib/sqlite/dispatcherMetrics/window.js";

/**
 * Folds finished hours of minute buckets into hourly buckets, incrementally.
 *
 * The stored watermark (`rolled_until`) marks the first hour not yet rolled
 * up; readers take hourly rows before it and minute rows after it. Each pass
 * re-rolls the hour just before the watermark too, so minute rows that land
 * late (a flush retried after a failure) still reach the hourly table.
 * The first pass backfills from the oldest minute bucket. Retention cuts
 * minute rows at an arbitrary minute, so that oldest hour is usually partial:
 * it fills a missing hourly row but never overwrites an existing (complete)
 * one.
 *
 * @param {{nowMs?: number}} [options]
 * @returns {{hourlyRows: number, rolledUntil: string|null}}
 */
export function rollupHourlyDispatcherMetrics({ nowMs = Date.now() } = {}) {
  const db = getMetricsDb();
  const currentHourIso = floorHourIso(nowMs);
  const rolledUntil = readRolledUntil(db);
  let fromIso;
  let overwriteFromIso;
  if (rolledUntil) {
    fromIso = new Date(Date.parse(rolledUntil) - HOUR_MS).toISOString();
    overwriteFromIso = fromIso;
  } else {
    const { oldest } = db
      .prepare("SELECT MIN(bucket_start) AS oldest FROM dispatcher_metrics_1m")
      .get();
    fromIso = oldest && floorHourIso(Date.parse(oldest));
    overwriteFromIso = oldest && new Date(Math.ceil(Date.parse(oldest) / HOUR_MS) * HOUR_MS).toISOString();
  }

  if (!fromIso || fromIso >= currentHourIso) {
    return { hourlyRows: 0, rolledUntil };
  }

  const hourKey = stepKeySql("bucket_start", HOUR_MS);
  const rollup = db.prepare(`
    INSERT INTO dispatcher_metrics_1h (
      provider, bucket_start, model_id, connection_id,
      request_count, completed_count, failed_count, timed_out_count, cancelled_count,
      queue_wait_ms_sum, ttft_ms_sum, total_duration_ms_sum,
      queue_wait_ms_max, ttft_ms_max, total_duration_ms_max,
      ttft_hist_json, queue_hist_json, duration_hist_json
    )
    SELECT provider, ${hourKey}, model_id, connection_id,
           SUM(request_count), SUM(completed_count), SUM(failed_count),
           SUM(timed_out_count), SUM(cancelled_count),
           SUM(queue_wait_ms_sum), SUM(ttft_ms_sum), SUM(total_duration_ms_sum),
           MAX(queue_wait_ms_max), MAX(ttft_ms_max), MAX(total_duration_ms_max),
           hist_sum(ttft_hist_json), hist_sum(queue_hist_json), hist_sum(duration_hist_json)
    FROM dispatcher_metrics_1m
    WHERE bucket_start >= @fromIso AND bucket_start < @untilIso
    GROUP BY provider, ${hourKey}, model_id, connection_id
    ON CONFLICT(provider, bucket_start, model_id, connection_id) DO UPDATE SET
      request_count = excluded.request_count,
      completed_count = excluded.completed_count,
      failed_count = excluded.failed_count,
      timed_out_count = excluded.timed_out_count,
      cancelled_count = excluded.cancelled_count,
      queue_wait_ms_sum = excluded.queue_wait_ms_sum,
      ttft_ms_sum = excluded.ttft_ms_sum,
      total_duration_ms_sum = excluded.total_duration_ms_sum,
      queue_wait_ms_max = excluded.queue_wait_ms_max,
      ttft_ms_max = excluded.ttft_ms_max,
      total_duration_ms_max = excluded.total_duration_ms_max,
      ttft_hist_json = excluded.ttft_hist_json,
      queue_hist_json = excluded.queue_hist_json,
      duration_hist_json = excluded.duration_hist_json
    WHERE excluded.bucket_start >= @overwriteFromIso
  `);
  const saveWatermark = db.prepare(`
    INSERT INTO dispatcher_metrics_rollup_state (id, rolled_until) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET rolled_until = excluded.rolled_until
  `);

  const hourlyRows = db.transaction(() => {
    const { changes } = rollup.run({ fromIso, untilIso: currentHourIso, overwriteFromIso });
    saveWatermark.run(currentHourIso);
    return changes;
  })();
  return { hourlyRows, rolledUntil: currentHourIso };
}

function floorHourIso(ms) {
  return new Date(Math.floor(ms / HOUR_MS) * HOUR_MS).toISOString();
}
