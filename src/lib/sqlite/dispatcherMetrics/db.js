import { getSqlite } from "@/lib/sqlite/runtime.js";
import {
  createEmptyHistogram,
  mergeHistograms,
  parseHistogram,
} from "@/lib/dispatcher/histogram.js";

const connectionsWithHistogramFunctions = new WeakSet();

/**
 * Returns the SQLite connection with the latency-histogram SQL functions
 * registered, so writes and reads merge histograms inside SQLite:
 *  - hist_merge(a, b): scalar, element-wise sum of two histogram JSON arrays
 *  - hist_sum(h):      aggregate, element-wise sum over a group
 */
export function getMetricsDb() {
  const db = getSqlite();
  if (connectionsWithHistogramFunctions.has(db)) return db;

  db.function("hist_merge", { deterministic: true }, (left, right) =>
    JSON.stringify(mergeHistograms(parseHistogram(left), parseHistogram(right))),
  );
  db.aggregate("hist_sum", {
    start: createEmptyHistogram,
    step: (total, raw) => mergeHistograms(total, parseHistogram(raw)),
    result: (total) => JSON.stringify(total),
  });
  connectionsWithHistogramFunctions.add(db);
  return db;
}
