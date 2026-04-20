import { DISPATCH_TIMEOUT_KIND } from "@/lib/dispatcher/types.js";

export const DEFAULT_TIMEOUT_POLICY = Object.freeze({
  queueTtlMs: 10 * 60 * 1000,
  connectTimeoutMs: 30 * 1000,
  ttftTimeoutMs: 3 * 60 * 1000,
  idleTimeoutMs: 60 * 1000,
  attemptDeadlineMs: 6 * 60 * 1000,
});

function toMs(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

export function createTimeoutPolicy(overrides = {}) {
  return {
    queueTtlMs: toMs(overrides.queueTtlMs, DEFAULT_TIMEOUT_POLICY.queueTtlMs),
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

  if (
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
