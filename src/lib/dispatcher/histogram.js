/**
 * Logarithmic latency histogram sketch (DDSketch / HdrHistogram principles).
 * Provides O(1) binning, algebraic mergeability, and rank-based percentile estimation.
 */

// 16 Logarithmic latency bin upper thresholds in milliseconds
export const LATENCY_BUCKET_THRESHOLDS = [
  10,     // <= 10ms
  25,     // <= 25ms
  50,     // <= 50ms
  100,    // <= 100ms
  250,    // <= 250ms
  500,    // <= 500ms
  1000,   // <= 1s
  2000,   // <= 2s
  4000,   // <= 4s
  8000,   // <= 8s
  15000,  // <= 15s
  30000,  // <= 30s
  60000,  // <= 1m
  120000, // <= 2m
  300000, // <= 5m
];

export const HISTOGRAM_BIN_COUNT = LATENCY_BUCKET_THRESHOLDS.length + 1; // 16 bins (last is > 300s)

/**
 * Creates an empty histogram array filled with zeros.
 * @returns {number[]}
 */
export function createEmptyHistogram() {
  return new Array(HISTOGRAM_BIN_COUNT).fill(0);
}

/**
 * Records a latency measurement into the histogram in O(1) time.
 * @param {number[]} histogram 
 * @param {number|null|undefined} valueMs 
 */
export function recordLatency(histogram, valueMs) {
  if (!Array.isArray(histogram)) return;
  const ms = Math.max(0, Number(valueMs) || 0);
  for (let i = 0; i < LATENCY_BUCKET_THRESHOLDS.length; i++) {
    if (ms <= LATENCY_BUCKET_THRESHOLDS[i]) {
      histogram[i] = (histogram[i] || 0) + 1;
      return;
    }
  }
  // Overflow bin (> 300,000ms)
  const overflowIndex = HISTOGRAM_BIN_COUNT - 1;
  histogram[overflowIndex] = (histogram[overflowIndex] || 0) + 1;
}

/**
 * Merges source histogram into target histogram algebraically.
 * @param {number[]} target 
 * @param {number[]} source 
 * @returns {number[]} target
 */
export function mergeHistograms(target, source) {
  if (!Array.isArray(target) || !Array.isArray(source)) return target;
  const len = Math.min(target.length, source.length);
  for (let i = 0; i < len; i++) {
    target[i] = (target[i] || 0) + (source[i] || 0);
  }
  return target;
}

/**
 * Parses a histogram from JSON string or array, safely defaulting to empty.
 * @param {string|number[]} raw 
 * @returns {number[]}
 */
export function parseHistogram(raw) {
  if (Array.isArray(raw)) {
    if (raw.length === HISTOGRAM_BIN_COUNT) return raw.map(Number);
    const h = createEmptyHistogram();
    mergeHistograms(h, raw);
    return h;
  }
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parseHistogram(parsed);
    } catch {
      // ignore
    }
  }
  return createEmptyHistogram();
}

/**
 * Computes multiple percentiles from a histogram.
 * @param {number[]} histogram 
 * @param {number[]} [percentiles=[50, 90, 95, 99]]
 * @returns {Record<string, number>} e.g. { p50: 250, p90: 1000, p95: 2000, p99: 4000, max: 8000 }
 */
export function calculatePercentiles(histogram, percentiles = [50, 90, 95, 99]) {
  if (!Array.isArray(histogram)) {
    return { p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  }

  const total = histogram.reduce((acc, count) => acc + (Number(count) || 0), 0);
  if (total === 0) {
    const result = { max: 0 };
    for (const p of percentiles) {
      result[`p${p}`] = 0;
    }
    return result;
  }

  // Find max observed bucket
  let maxVal = 0;
  for (let i = histogram.length - 1; i >= 0; i--) {
    if (histogram[i] > 0) {
      maxVal = i < LATENCY_BUCKET_THRESHOLDS.length ? LATENCY_BUCKET_THRESHOLDS[i] : 300000;
      break;
    }
  }

  const result = { max: maxVal };
  for (const p of percentiles) {
    const targetRank = Math.ceil(total * (p / 100));
    let cumulative = 0;
    let found = false;

    for (let i = 0; i < histogram.length; i++) {
      cumulative += (Number(histogram[i]) || 0);
      if (cumulative >= targetRank) {
        result[`p${p}`] = i < LATENCY_BUCKET_THRESHOLDS.length
          ? LATENCY_BUCKET_THRESHOLDS[i]
          : 300000;
        found = true;
        break;
      }
    }
    if (!found) {
      result[`p${p}`] = maxVal;
    }
  }

  return result;
}
