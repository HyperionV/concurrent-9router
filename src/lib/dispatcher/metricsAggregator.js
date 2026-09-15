import {
  createEmptyHistogram,
  recordLatency,
  mergeHistograms,
} from "@/lib/dispatcher/histogram.js";
import { upsertDispatcherMinuteBuckets } from "@/lib/sqlite/dispatcherMetricsStore.js";

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

/**
 * High-performance, in-memory telemetry buffer.
 * Decouples request routing and SSE streaming completely from SQLite writes.
 * Accumulates counters and logarithmic histograms in RAM and periodically flushes.
 */
class DispatcherMetricsAggregator {
  constructor() {
    /** @type {Map<string, object>} */
    this.buffer = new Map();
  }

  /**
   * Records a terminal attempt into the in-memory buffer in O(1) time without blocking.
   * @param {object} attempt
   */
  recordAttemptCompletion(attempt) {
    if (!attempt || !attempt.id) return;

    const provider = attempt.provider || "codex";
    const modelId = attempt.modelId || "all";
    const connectionId = attempt.connectionId || "all";
    const state = attempt.state || "completed";

    // Use finished_at or queue_entered_at or now for bucket placement
    const timestamp = attempt.finishedAt || attempt.lastProgressAt || attempt.queueEnteredAt || Date.now();
    const bucketStart = toMinuteBucketIso(timestamp);

    // Key per provider/minute/model/connection
    const key = `${provider}:${bucketStart}:${modelId}:${connectionId}`;

    let b = this.buffer.get(key);
    if (!b) {
      b = {
        provider,
        bucketStart,
        modelId,
        connectionId,
        requestCount: 0,
        completedCount: 0,
        failedCount: 0,
        timedOutCount: 0,
        queueWaitMsSum: 0,
        ttftMsSum: 0,
        totalDurationMsSum: 0,
        queueWaitMsMax: 0,
        ttftMsMax: 0,
        totalDurationMsMax: 0,
        ttftHist: createEmptyHistogram(),
        queueHist: createEmptyHistogram(),
      };
      this.buffer.set(key, b);
    }

    b.requestCount += 1;
    if (state === "completed") {
      b.completedCount += 1;
    } else if (state === "timed_out") {
      b.timedOutCount += 1;
    } else {
      b.failedCount += 1;
    }

    // Queue wait latency (leased_at - queue_entered_at)
    if (attempt.leasedAt && attempt.queueEnteredAt) {
      const qWait = Math.max(0, new Date(attempt.leasedAt).getTime() - new Date(attempt.queueEnteredAt).getTime());
      if (Number.isFinite(qWait)) {
        b.queueWaitMsSum += qWait;
        b.queueWaitMsMax = Math.max(b.queueWaitMsMax, qWait);
        recordLatency(b.queueHist, qWait);
      }
    }

    // TTFT latency (first_progress_at - connect_started_at)
    if (attempt.firstProgressAt && attempt.connectStartedAt) {
      const ttft = Math.max(0, new Date(attempt.firstProgressAt).getTime() - new Date(attempt.connectStartedAt).getTime());
      if (Number.isFinite(ttft)) {
        b.ttftMsSum += ttft;
        b.ttftMsMax = Math.max(b.ttftMsMax, ttft);
        recordLatency(b.ttftHist, ttft);
      }
    }

    // Total duration (finished_at - queue_entered_at)
    if (attempt.finishedAt && attempt.queueEnteredAt) {
      const totalDur = Math.max(0, new Date(attempt.finishedAt).getTime() - new Date(attempt.queueEnteredAt).getTime());
      if (Number.isFinite(totalDur)) {
        b.totalDurationMsSum += totalDur;
        b.totalDurationMsMax = Math.max(b.totalDurationMsMax, totalDur);
      }
    }
  }

  /**
   * Flushes uncommitted in-memory buckets into SQLite via a single transaction.
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
      // Re-insert on failure so data is not lost
      for (const item of items) {
        const key = `${item.provider}:${item.bucketStart}:${item.modelId}:${item.connectionId}`;
        const existing = this.buffer.get(key);
        if (existing) {
          existing.requestCount += item.requestCount;
          existing.completedCount += item.completedCount;
          existing.failedCount += item.failedCount;
          existing.timedOutCount += item.timedOutCount;
          existing.queueWaitMsSum += item.queueWaitMsSum;
          existing.ttftMsSum += item.ttftMsSum;
          existing.totalDurationMsSum += item.totalDurationMsSum;
          existing.queueWaitMsMax = Math.max(existing.queueWaitMsMax, item.queueWaitMsMax);
          existing.ttftMsMax = Math.max(existing.ttftMsMax, item.ttftMsMax);
          existing.totalDurationMsMax = Math.max(existing.totalDurationMsMax, item.totalDurationMsMax);
          mergeHistograms(existing.ttftHist, item.ttftHist);
          mergeHistograms(existing.queueHist, item.queueHist);
        } else {
          this.buffer.set(key, item);
        }
      }
      return 0;
    }
  }

  /**
   * Returns in-memory buffer entries for a specific provider.
   * @param {string} provider
   * @returns {Array<object>}
   */
  getBufferForProvider(provider) {
    const results = [];
    for (const item of this.buffer.values()) {
      if (item.provider === provider) {
        results.push(item);
      }
    }
    return results;
  }

  /**
   * Clears all in-memory items (used in testing).
   */
  clear() {
    this.buffer.clear();
  }
}

// Global singleton instance
export const dispatcherMetricsAggregator = new DispatcherMetricsAggregator();
