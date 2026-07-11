import { DISPATCH_TIMEOUT_KIND } from "@/lib/dispatcher/types.js";

/**
 * Max time a request may sit in the queue waiting for a free gate/slot,
 * measured from queue arrival (queuedAt / queueEnteredAt) until lease.
 * After this, the request is timed out (queue_expired) so the continuous
 * gate loop can keep serving fresher work.
 */
export const QUEUE_WAITING_LIMIT_MS = 5 * 60 * 1000;

export const DEFAULT_TIMEOUT_POLICY = Object.freeze({
  /** @deprecated use queueTtlMs — same as QUEUE_WAITING_LIMIT_MS (5 minutes) */
  queueTtlMs: QUEUE_WAITING_LIMIT_MS,
  /** Alias for docs / settings: waiting_limit from queue arrival */
  waitingLimitMs: QUEUE_WAITING_LIMIT_MS,
  connectTimeoutMs: 30 * 1000,
  ttftTimeoutMs: 3 * 60 * 1000,
  /**
   * No stream activity (lastProgress / streamStarted) for this long → idle_timeout.
   * Must stay below STREAM_STALL_TIMEOUT (6m) but above normal reasoning gaps.
   * Live streams also refresh lastProgress via upstream-byte heartbeats.
   */
  idleTimeoutMs: 3 * 60 * 1000,
  attemptDeadlineMs: 6 * 60 * 1000,
});

function toMs(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function createTimeoutPolicy(overrides = {}) {
  const waitingLimitMs = toMs(
    overrides.waitingLimitMs ?? overrides.queueTtlMs,
    QUEUE_WAITING_LIMIT_MS,
  );
  return {
    queueTtlMs: waitingLimitMs,
    waitingLimitMs,
    connectTimeoutMs: toMs(
      overrides.connectTimeoutMs,
      DEFAULT_TIMEOUT_POLICY.connectTimeoutMs,
    ),
    ttftTimeoutMs: toMs(
      overrides.ttftTimeoutMs,
      DEFAULT_TIMEOUT_POLICY.ttftTimeoutMs,
    ),
    idleTimeoutMs: toMs(
      overrides.idleTimeoutMs,
      DEFAULT_TIMEOUT_POLICY.idleTimeoutMs,
    ),
    attemptDeadlineMs: toMs(
      overrides.attemptDeadlineMs,
      DEFAULT_TIMEOUT_POLICY.attemptDeadlineMs,
    ),
  };
}

/**
 * Remaining queue wait budget for a request that entered the queue at `queueEnteredAt`.
 * Returns 0 if already expired (caller should timeout immediately).
 */
export function remainingQueueWaitMs(
  queueEnteredAt,
  policy = DEFAULT_TIMEOUT_POLICY,
  now = Date.now(),
) {
  const limitMs = createTimeoutPolicy(policy).waitingLimitMs;
  if (!queueEnteredAt) return limitMs;
  const entered = new Date(queueEnteredAt).getTime();
  if (!Number.isFinite(entered)) return limitMs;
  return Math.max(0, limitMs - (now - entered));
}

function parseTime(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function classifyAttemptTimeout(attempt, policy, now = Date.now()) {
  const effectivePolicy = createTimeoutPolicy(policy);
  const queueEnteredAt = parseTime(attempt?.queueEnteredAt);
  if (queueEnteredAt && now - queueEnteredAt >= effectivePolicy.queueTtlMs) {
    return DISPATCH_TIMEOUT_KIND.QUEUE_EXPIRED;
  }

  const leasedAt = parseTime(attempt?.leasedAt);
  const connectStartedAt = parseTime(attempt?.connectStartedAt);
  const streamStartedAt = parseTime(attempt?.streamStartedAt);
  const firstProgressAt = parseTime(attempt?.firstProgressAt);
  const lastProgressAt = parseTime(attempt?.lastProgressAt);

  const attemptStartedAt =
    leasedAt || connectStartedAt || streamStartedAt || queueEnteredAt;
  if (
    attemptStartedAt &&
    now - attemptStartedAt >= effectivePolicy.attemptDeadlineMs
  ) {
    return DISPATCH_TIMEOUT_KIND.ATTEMPT_DEADLINE;
  }

  // Only pure LEASED rows (never marked connecting). Attempts that admitted as
  // connecting use ttft/idle instead — connect_timeout must not kill live work
  // that has connect_started_at or has left the leased state.
  if (
    attempt?.state === "leased" &&
    !connectStartedAt &&
    leasedAt &&
    now - leasedAt >= effectivePolicy.connectTimeoutMs
  ) {
    return DISPATCH_TIMEOUT_KIND.CONNECT_TIMEOUT;
  }

  if (
    connectStartedAt &&
    !firstProgressAt &&
    now - connectStartedAt >= effectivePolicy.ttftTimeoutMs
  ) {
    return DISPATCH_TIMEOUT_KIND.TTFT_TIMEOUT;
  }

  const progressReference =
    lastProgressAt || firstProgressAt || streamStartedAt;
  if (
    progressReference &&
    now - progressReference >= effectivePolicy.idleTimeoutMs
  ) {
    return DISPATCH_TIMEOUT_KIND.IDLE_TIMEOUT;
  }

  return null;
}
