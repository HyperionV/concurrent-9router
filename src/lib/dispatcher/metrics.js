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

function deriveDispatcherMode(settings = {}) {
  if (settings.dispatcherEnabled === true) return "managed";
  if (settings.dispatcherShadowMode === true) return "shadow";
  return "off";
}

function buildCapacitySummary({
  connectionViews,
  settings,
  inMemory,
  activeAttempts,
}) {
  const slotsPerConnection = Math.max(
    1,
    Number(settings?.dispatcherSlotsPerConnection) || 1,
  );
  const activeConnections = connectionViews.length;
  const activeLeases = activeAttempts.length;
  const totalCapacity = activeConnections * slotsPerConnection;

  return {
    slotsPerConnection,
    activeConnections,
    totalCapacity,
    activeLeases,
    availableLeases: Math.max(0, totalCapacity - activeLeases),
    utilization:
      totalCapacity > 0 ? Number((activeLeases / totalCapacity).toFixed(4)) : 0,
    occupancyByConnection: {
      ...(inMemory?.occupancyByConnection || {}),
    },
  };
}

function summarizeConnectionHealth(connectionId, recentAttempts) {
  const attempts = recentAttempts.filter(
    (attempt) => attempt.connectionId === connectionId,
  );
  const terminalReasonCounts = {};
  let lastAttemptAt = null;

  for (const attempt of attempts) {
    increment(terminalReasonCounts, attempt.terminalReason);
    const candidate =
      attempt.finishedAt ||
      attempt.lastProgressAt ||
      attempt.firstProgressAt ||
      attempt.streamStartedAt ||
      attempt.connectStartedAt ||
      attempt.leasedAt ||
      attempt.queueEnteredAt ||
      null;
    if (
      candidate &&
      (!lastAttemptAt || String(candidate) > String(lastAttemptAt))
    ) {
      lastAttemptAt = candidate;
    }
  }

  return {
    recentAttempts: attempts.length,
    recentTerminalReasonCounts: terminalReasonCounts,
    lastAttemptAt,
  };
}

function summarizeConnections({
  connectionViews,
  settings,
  inMemory,
  recentAttempts,
}) {
  const slotsPerConnection = Math.max(
    1,
    Number(settings?.dispatcherSlotsPerConnection) || 1,
  );
  const occupancyByConnection = inMemory?.occupancyByConnection || {};

  return [...connectionViews]
    .map((connection) => {
      const occupiedSlots = Number(occupancyByConnection[connection.id] || 0);
      const health = summarizeConnectionHealth(connection.id, recentAttempts);
      return {
        connectionId: connection.id,
        connectionName:
          connection.displayName ||
          connection.name ||
          connection.email ||
          connection.id,
        occupiedSlots,
        capacity: slotsPerConnection,
        availableSlots: Math.max(0, slotsPerConnection - occupiedSlots),
        proxyPoolId:
          connection.providerSpecificData?.connectionProxyPoolId || null,
        strictProxy: connection.providerSpecificData?.strictProxy === true,
        recentAttempts: health.recentAttempts,
        recentTerminalReasonCounts: health.recentTerminalReasonCounts,
        lastAttemptAt: health.lastAttemptAt,
      };
    })
    .sort((a, b) => {
      const occupancyDiff = b.occupiedSlots - a.occupiedSlots;
      if (occupancyDiff !== 0) return occupancyDiff;
      return a.connectionName.localeCompare(b.connectionName);
    });
}

export function getDispatcherStatusSnapshot({
  provider = "codex",
  recentLimit = 20,
  settings = {},
  inMemory = null,
  connectionViews = [],
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
    mode: deriveDispatcherMode(settings),
    generatedAt: new Date().toISOString(),
    settings: {
      dispatcherEnabled: settings.dispatcherEnabled === true,
      dispatcherShadowMode: settings.dispatcherShadowMode === true,
      dispatcherCodexOnly: settings.dispatcherCodexOnly !== false,
      dispatcherSlotsPerConnection:
        Number(settings.dispatcherSlotsPerConnection) || 1,
    },
    capacity: buildCapacitySummary({
      connectionViews,
      settings,
      inMemory,
      activeAttempts,
    }),
    queued: summarizeQueuedRequests(queuedRequests),
    active: summarizeActiveAttempts(activeAttempts),
    terminal: summarizeTerminalAttempts(terminalAttempts),
    requestStatusByRecentAttempts: summarizeRequestsForAttempts(recentAttempts),
    connections: summarizeConnections({
      connectionViews,
      settings,
      inMemory,
      recentAttempts,
    }),
    recentAttempts,
  };
}
