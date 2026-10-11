import {
  createEmptyHistogram,
  recordLatency,
  mergeHistograms,
} from "@/lib/dispatcher/histogram.js";
import { upsertDispatcherMinuteBuckets } from "@/lib/sqlite/dispatcherMetrics/writes.js";

/**
 * Truncates an ISO timestamp or date millis to the nearest minute boundary.
 * @param {number|string|Date} [date]
 * @returns {string} ISO minute timestamp
 */
export function toMinuteBucketIso(date = Date.now()) {
  const ms = typeof date === "number" ? date : new Date(date).getTime();
  const validMs = Number.isFinite(ms) ? ms : Date.now();
  return new Date(Math.floor(validMs / 60000) * 60000).toISOString();
}

// Attempts recorded without a model or account land under this key.
const UNATTRIBUTED_KEY = "all";

function bucketKey({ provider, bucketStart, modelId, connectionId }) {
  return `${provider}:${bucketStart}:${modelId}:${connectionId}`;
}

function createBucket(provider, bucketStart, modelId, connectionId) {
  return {
    provider,
    bucketStart,
    modelId,
    connectionId,
    requestCount: 0,
    completedCount: 0,
    failedCount: 0,
    timedOutCount: 0,
    cancelledCount: 0,
    queueWaitMsSum: 0,
    ttftMsSum: 0,
    totalDurationMsSum: 0,
    queueWaitMsMax: 0,
    ttftMsMax: 0,
    totalDurationMsMax: 0,
    ttftHist: createEmptyHistogram(),
    queueHist: createEmptyHistogram(),
    durationHist: createEmptyHistogram(),
  };
}

function mergeBucketInto(target, source) {
  target.requestCount += source.requestCount;
  target.completedCount += source.completedCount;
  target.failedCount += source.failedCount;
  target.timedOutCount += source.timedOutCount;
  target.cancelledCount += source.cancelledCount;
  target.queueWaitMsSum += source.queueWaitMsSum;
  target.ttftMsSum += source.ttftMsSum;
  target.totalDurationMsSum += source.totalDurationMsSum;
  target.queueWaitMsMax = Math.max(target.queueWaitMsMax, source.queueWaitMsMax);
  target.ttftMsMax = Math.max(target.ttftMsMax, source.ttftMsMax);
  target.totalDurationMsMax = Math.max(target.totalDurationMsMax, source.totalDurationMsMax);
  mergeHistograms(target.ttftHist, source.ttftHist);
  mergeHistograms(target.queueHist, source.queueHist);
  mergeHistograms(target.durationHist, source.durationHist);
}

function elapsedMs(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/**
 * In-memory telemetry buffer. Request routing records terminal attempts in
 * O(1); a periodic flush writes the buffered minute buckets to SQLite.
 */
class DispatcherMetricsAggregator {
  constructor() {
    /** @type {Map<string, object>} */
    this.buffer = new Map();
  }

  /**
   * Records a terminal attempt into its minute bucket.
   * @param {object} attempt a normalized dispatch attempt in a terminal state
   */
  recordAttemptCompletion(attempt) {
    if (!attempt || !attempt.id) return;

    const provider = attempt.provider || "codex";
    const modelId = attempt.modelId || UNATTRIBUTED_KEY;
    const connectionId = attempt.connectionId || UNATTRIBUTED_KEY;
    const bucketStart = toMinuteBucketIso(
      attempt.finishedAt || attempt.lastProgressAt || attempt.queueEnteredAt || Date.now(),
    );
    const key = bucketKey({ provider, bucketStart, modelId, connectionId });

    let bucket = this.buffer.get(key);
    if (!bucket) {
      bucket = createBucket(provider, bucketStart, modelId, connectionId);
      this.buffer.set(key, bucket);
    }

    bucket.requestCount += 1;
    if (attempt.state === "completed") bucket.completedCount += 1;
    else if (attempt.state === "timed_out") bucket.timedOutCount += 1;
    else if (attempt.state === "cancelled") bucket.cancelledCount += 1;
    else bucket.failedCount += 1;

    const queueWait = elapsedMs(attempt.queueEnteredAt, attempt.leasedAt);
    if (queueWait !== null) {
      bucket.queueWaitMsSum += queueWait;
      bucket.queueWaitMsMax = Math.max(bucket.queueWaitMsMax, queueWait);
      recordLatency(bucket.queueHist, queueWait);
    }

    const ttft = elapsedMs(attempt.connectStartedAt, attempt.firstProgressAt);
    if (ttft !== null) {
      bucket.ttftMsSum += ttft;
      bucket.ttftMsMax = Math.max(bucket.ttftMsMax, ttft);
      recordLatency(bucket.ttftHist, ttft);
    }

    const duration = elapsedMs(attempt.queueEnteredAt, attempt.finishedAt);
    if (duration !== null) {
      bucket.totalDurationMsSum += duration;
      bucket.totalDurationMsMax = Math.max(bucket.totalDurationMsMax, duration);
      recordLatency(bucket.durationHist, duration);
    }
  }

  /**
   * Writes buffered buckets to SQLite in one transaction. On failure the
   * buckets go back into the buffer (merged with anything recorded since)
   * and the next flush retries them.
   * @returns {number} number of flushed bucket rows
   */
  flushToSqlite() {
    if (this.buffer.size === 0) return 0;
    const items = Array.from(this.buffer.values());
    this.buffer.clear();

    try {
      upsertDispatcherMinuteBuckets(items);
      return items.length;
    } catch (error) {
      console.error("[DispatcherMetricsAggregator] Flush failed, restoring buffer:", error.message);
      for (const item of items) {
        const key = bucketKey(item);
        const existing = this.buffer.get(key);
        if (existing) mergeBucketInto(existing, item);
        else this.buffer.set(key, item);
      }
      return 0;
    }
  }

  /** Drops all buffered buckets (test isolation). */
  clear() {
    this.buffer.clear();
  }
}

// Process-global singleton instance across Next.js / Webpack module copies
export const dispatcherMetricsAggregator =
  (globalThis.__dispatcherMetricsAggregator ||= new DispatcherMetricsAggregator());
