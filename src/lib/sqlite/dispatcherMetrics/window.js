/**
 * The one rule for turning a dashboard range into a time window and the
 * bucket tables that cover it.
 *
 * Minute buckets are kept for 7 days and hourly buckets for 90 days. Hourly
 * buckets exist only for hours the rollup has finished (everything before the
 * stored watermark), so an hour-step window reads hourly rows up to the
 * watermark and minute rows after it. Finer steps always read minute rows.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const METRICS_RANGES = Object.freeze({
  "1h": { durationMs: HOUR_MS, stepMs: MINUTE_MS },
  "24h": { durationMs: DAY_MS, stepMs: 15 * MINUTE_MS },
  "7d": { durationMs: 7 * DAY_MS, stepMs: HOUR_MS },
});

export const DEFAULT_METRICS_RANGE = "24h";

export function normalizeMetricsRange(range) {
  return Object.hasOwn(METRICS_RANGES, range) ? range : DEFAULT_METRICS_RANGE;
}

const toIso = (ms) => new Date(ms).toISOString();

/**
 * @param {keyof METRICS_RANGES} range
 * @param {object} options
 * @param {number} options.nowMs
 * @param {string|null} options.rolledUntilIso hourly rollup watermark
 * @param {number} [options.periodsBack=0] 1 = the window immediately before
 * @returns {{
 *   range: string, stepMs: number, sinceIso: string, untilIso: string,
 *   hourly: {fromIso: string, toIso: string}|null,
 *   minute: {fromIso: string, toIso: string}|null,
 * }}
 *   The window ends at the end of the step containing `nowMs`, so the newest
 *   (partial) step is always the last point.
 */
export function resolveMetricsWindow(
  range,
  { nowMs, rolledUntilIso, periodsBack = 0 },
) {
  const { durationMs, stepMs } = METRICS_RANGES[range];
  const untilMs =
    (Math.floor(nowMs / stepMs) + 1) * stepMs - periodsBack * durationMs;
  const sinceMs = untilMs - durationMs;

  const watermarkMs = rolledUntilIso ? Date.parse(rolledUntilIso) : sinceMs;
  const splitMs =
    stepMs >= HOUR_MS ? Math.min(untilMs, Math.max(sinceMs, watermarkMs)) : sinceMs;

  return {
    range,
    stepMs,
    sinceIso: toIso(sinceMs),
    untilIso: toIso(untilMs),
    hourly:
      splitMs > sinceMs ? { fromIso: toIso(sinceMs), toIso: toIso(splitMs) } : null,
    minute:
      splitMs < untilMs ? { fromIso: toIso(splitMs), toIso: toIso(untilMs) } : null,
  };
}

/** Every step start in the window, oldest first, for gap-free charts. */
export function listStepStarts(window) {
  const starts = [];
  const untilMs = Date.parse(window.untilIso);
  for (let ms = Date.parse(window.sinceIso); ms < untilMs; ms += window.stepMs) {
    starts.push(toIso(ms));
  }
  return starts;
}

/**
 * SQL expression mapping an ISO timestamp column to the ISO start of its step.
 * Relies on timestamps being written with Date#toISOString.
 */
export function stepKeySql(column, stepMs) {
  if (stepMs === MINUTE_MS) return `substr(${column}, 1, 16) || ':00.000Z'`;
  if (stepMs === HOUR_MS) return `substr(${column}, 1, 13) || ':00:00.000Z'`;
  const stepMinutes = stepMs / MINUTE_MS;
  if (!Number.isInteger(stepMinutes) || 60 % stepMinutes !== 0) {
    throw new Error(`step of ${stepMinutes} minutes does not divide an hour`);
  }
  return `substr(${column}, 1, 14) || printf('%02d', (CAST(substr(${column}, 15, 2) AS INTEGER) / ${stepMinutes}) * ${stepMinutes}) || ':00.000Z'`;
}
