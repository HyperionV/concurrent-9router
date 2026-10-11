import {
  calculatePercentiles,
  parseHistogram,
} from "@/lib/dispatcher/histogram.js";

/**
 * Turns summed rows from source.js into dashboard statistics. Every average
 * divides by the number of samples actually measured (the histogram total),
 * not by request counts, because not every attempt reaches first token.
 */

const num = (value) => Number(value) || 0;

function latencyStats(sumMs, maxMs, histJson, percentiles) {
  const hist = parseHistogram(histJson);
  const samples = hist.reduce((total, count) => total + count, 0);
  const result = {
    samples,
    avgMs: samples > 0 ? Math.round(num(sumMs) / samples) : 0,
    maxMs: num(maxMs),
  };
  const computed = calculatePercentiles(hist, percentiles);
  for (const p of percentiles) result[`p${p}Ms`] = computed[`p${p}`];
  return result;
}

export const EMPTY_BUCKET_ROW = Object.freeze({});

/** @param {object} row a summed dispatcher bucket row (or EMPTY_BUCKET_ROW) */
export function summarizeBuckets(row) {
  const attempts = num(row.request_count);
  const completed = num(row.completed_count);
  const failed = num(row.failed_count);
  const timedOut = num(row.timed_out_count);
  const cancelled = num(row.cancelled_count);
  // A client walking away says nothing about upstream health.
  const decided = attempts - cancelled;
  const duration = latencyStats(row.total_duration_ms_sum, row.total_duration_ms_max, row.duration_hist_json, [50, 95]);
  // Every terminal attempt has a duration, including rows written before the
  // duration histogram existed, so the average divides by attempts.
  duration.avgMs = attempts > 0 ? Math.round(num(row.total_duration_ms_sum) / attempts) : 0;
  return {
    attempts,
    completed,
    failed,
    timedOut,
    cancelled,
    successRate: decided > 0 ? completed / decided : null,
    ttft: latencyStats(row.ttft_ms_sum, row.ttft_ms_max, row.ttft_hist_json, [50, 90, 95, 99]),
    queueWait: latencyStats(row.queue_wait_ms_sum, row.queue_wait_ms_max, row.queue_hist_json, [50, 95]),
    duration,
  };
}

/** @param {object} row a summed usage row (or EMPTY_BUCKET_ROW) */
export function summarizeUsage(row) {
  const promptTokens = num(row.prompt_tokens);
  const completionTokens = num(row.completion_tokens);
  const cachedTokens = num(row.cached_tokens);
  return {
    requests: num(row.request_count),
    promptTokens,
    completionTokens,
    cachedTokens,
    totalTokens: promptTokens + completionTokens,
    // prompt_tokens already includes the cached part of the prompt.
    cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : null,
    cost: num(row.cost),
  };
}

/** Indexes rows by a group key, e.g. indexBy(rows, "model"). */
export function indexBy(rows, key) {
  return new Map(rows.map((row) => [row[key], row]));
}
