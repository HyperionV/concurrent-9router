import {
  getDispatchRequest,
  listActiveDispatchAttempts,
  listDispatchAttemptEvents,
  listDispatchAttemptsByState,
  listQueuedDispatchRequests,
} from "@/lib/sqlite/dispatcherStore.js";

function toIsoAgeMs(timestamp) {
  if (!timestamp) return null;
  const millis = new Date(timestamp).getTime();
  if (!Number.isFinite(millis)) return null;
  return Math.max(0, Date.now() - millis);
}

function increment(map, key, amount = 1) {
  const normalizedKey = key || "unknown";
  map[normalizedKey] = (map[normalizedKey] || 0) + amount;
}

function summarizeQueuedRequests(queuedRequests) {
  const byModel = {};
  let oldestQueuedAt = null;
  let newestQueuedAt = null;

  for (const request of queuedRequests) {
    increment(byModel, request.modelId);
    if (!oldestQueuedAt || request.queuedAt < oldestQueuedAt) {
      oldestQueuedAt = request.queuedAt;
    }
    if (!newestQueuedAt || request.queuedAt > newestQueuedAt) {
      newestQueuedAt = request.queuedAt;
    }
  }

  return {
    count: queuedRequests.length,
    byModel,
    oldestQueuedAt,
    oldestQueueAgeMs: toIsoAgeMs(oldestQueuedAt),
    newestQueuedAt,
    newestQueueAgeMs: toIsoAgeMs(newestQueuedAt),
  };
}

function summarizeActiveAttempts(activeAttempts) {
  const byState = {};
  const byConnection = {};
  const byPathMode = {};

  for (const attempt of activeAttempts) {
    increment(byState, attempt.state);
    increment(byConnection, attempt.connectionId);
    increment(byPathMode, attempt.pathMode);
  }

  return {
    count: activeAttempts.length,
    byState,
    byConnection,
    byPathMode,
  };
}

function summarizeTerminalAttempts(terminalAttempts) {
  const byState = {};
  const byTimeoutKind = {};
  const byTerminalReason = {};
  const byPathMode = {};

  for (const attempt of terminalAttempts) {
    increment(byState, attempt.state);
    increment(byTimeoutKind, attempt.timeoutKind);
    increment(byTerminalReason, attempt.terminalReason);
    increment(byPathMode, attempt.pathMode);
  }

  return {
    count: terminalAttempts.length,
    byState,
    byTimeoutKind,
    byTerminalReason,
    byPathMode,
  };
}

function summarizeRequestsForAttempts(attempts) {
  const requestStatusCounts = {};
  for (const attempt of attempts) {
    const request = getDispatchRequest(attempt.requestId);
    increment(requestStatusCounts, request?.status);
  }
  return requestStatusCounts;
}

export function getDispatcherStatusSnapshot({
  provider = "codex",
  recentLimit = 20,
} = {}) {
  const queuedRequests = listQueuedDispatchRequests(provider, 500);
  const activeAttempts = listActiveDispatchAttempts(provider);
  const terminalAttempts = listDispatchAttemptsByState([
    "completed",
    "failed",
    "timed_out",
    "cancelled",
    "reconciled",
  ]).filter((attempt) => attempt.provider === provider);

  const recentAttempts = [...activeAttempts, ...terminalAttempts]
    .sort((a, b) => {
      const aTime =
        a.finishedAt ||
        a.lastProgressAt ||
        a.firstProgressAt ||
        a.streamStartedAt ||
        a.connectStartedAt ||
        a.leasedAt ||
        a.queueEnteredAt ||
        "";
      const bTime =
        b.finishedAt ||
        b.lastProgressAt ||
        b.firstProgressAt ||
        b.streamStartedAt ||
        b.connectStartedAt ||
        b.leasedAt ||
        b.queueEnteredAt ||
        "";
      return String(bTime).localeCompare(String(aTime));
    })
    .slice(0, recentLimit)
    .map((attempt) => ({
      ...attempt,
      request: getDispatchRequest(attempt.requestId),
      events: listDispatchAttemptEvents(attempt.id),
    }));

  return {
    provider,
    generatedAt: new Date().toISOString(),
    queued: summarizeQueuedRequests(queuedRequests),
    active: summarizeActiveAttempts(activeAttempts),
    terminal: summarizeTerminalAttempts(terminalAttempts),
    requestStatusByRecentAttempts: summarizeRequestsForAttempts(recentAttempts),
    recentAttempts,
  };
}
