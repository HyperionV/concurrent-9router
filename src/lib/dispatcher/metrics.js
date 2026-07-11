import {
  listActiveDispatchAttempts,
  listDispatchAttemptsByState,
  listQueuedDispatchRequests,
} from "@/lib/sqlite/dispatcherStore.js";
import { deriveDispatcherMode } from "@/lib/dispatcher/settings.js";

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

function summarizeConnectionHealth(
  connectionId,
  activeAttempts,
  terminalAttempts,
) {
  const attempts = [...activeAttempts, ...terminalAttempts].filter(
    (attempt) => attempt.connectionId === connectionId,
  );
  const terminalReasonCounts = {};
  let lastAttemptAt = null;

  for (const attempt of attempts) {
    if (
      attempt.state !== "leased" &&
      attempt.state !== "connecting" &&
      attempt.state !== "streaming"
    ) {
      increment(terminalReasonCounts, attempt.terminalReason);
    }
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
  activeAttempts,
  terminalAttempts,
}) {
  const slotsPerConnection = Math.max(
    1,
    Number(settings?.dispatcherSlotsPerConnection) || 1,
  );
  const occupancyByConnection = inMemory?.occupancyByConnection || {};

  return [...connectionViews]
    .map((connection) => {
      const occupiedSlots = Number(occupancyByConnection[connection.id] || 0);
      const health = summarizeConnectionHealth(
        connection.id,
        activeAttempts,
        terminalAttempts,
      );
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

function summarizeModels(queuedRequests, activeAttempts, terminalAttempts) {
  const byModel = new Map();

  function ensureModel(modelId) {
    const key = modelId || "unknown";
    if (!byModel.has(key)) {
      byModel.set(key, {
        modelId: key,
        queued: 0,
        active: 0,
        completed: 0,
        failed: 0,
        timedOut: 0,
        cancelled: 0,
        reconciled: 0,
        total: 0,
      });
    }
    return byModel.get(key);
  }

  for (const request of queuedRequests) {
    const entry = ensureModel(request.modelId);
    entry.queued += 1;
    entry.total += 1;
  }

  for (const attempt of activeAttempts) {
    const entry = ensureModel(attempt.modelId);
    entry.active += 1;
    entry.total += 1;
  }

  for (const attempt of terminalAttempts) {
    const entry = ensureModel(attempt.modelId);
    if (attempt.state === "completed") entry.completed += 1;
    if (attempt.state === "failed") entry.failed += 1;
    if (attempt.state === "timed_out") entry.timedOut += 1;
    if (attempt.state === "cancelled") entry.cancelled += 1;
    if (attempt.state === "reconciled") entry.reconciled += 1;
    entry.total += 1;
  }

  return [...byModel.values()].sort((a, b) => {
    const totalDiff = b.total - a.total;
    if (totalDiff !== 0) return totalDiff;
    return a.modelId.localeCompare(b.modelId);
  });
}

function summarizePaths(activeAttempts, terminalAttempts) {
  const byPath = new Map();

  function ensurePath(pathMode) {
    const key = pathMode || "unknown";
    if (!byPath.has(key)) {
      byPath.set(key, {
        pathMode: key,
        active: 0,
        completed: 0,
        failed: 0,
        timedOut: 0,
        total: 0,
      });
    }
    return byPath.get(key);
  }

  for (const attempt of activeAttempts) {
    const entry = ensurePath(attempt.pathMode);
    entry.active += 1;
    entry.total += 1;
  }

  for (const attempt of terminalAttempts) {
    const entry = ensurePath(attempt.pathMode);
    if (attempt.state === "completed") entry.completed += 1;
    if (attempt.state === "failed") entry.failed += 1;
    if (attempt.state === "timed_out") entry.timedOut += 1;
    entry.total += 1;
  }

  return [...byPath.values()].sort((a, b) => {
    const totalDiff = b.total - a.total;
    if (totalDiff !== 0) return totalDiff;
    return a.pathMode.localeCompare(b.pathMode);
  });
}

/**
 * @param {object} options
 * @param {"live"|"history"|"full"} [options.view]
 *   live = queue + active + capacity only
 *   history = terminal aggregates only
 *   full = both (default)
 * @param {number} [options.terminalLimit] cap terminal rows (default 100)
 */
export function getDispatcherStatusSnapshot({
  provider = "codex",
  settings = {},
  inMemory = null,
  connectionViews = [],
  view = "full",
  terminalLimit = 100,
} = {}) {
  const includeLive = view === "live" || view === "full";
  const includeHistory = view === "history" || view === "full";

  const queuedRequests = includeLive
    ? listQueuedDispatchRequests(provider, 500)
    : [];
  const activeAttempts = includeLive
    ? listActiveDispatchAttempts(provider)
    : [];
  // OPT-004: filter + cap terminal attempts in SQL by provider
  const terminalAttempts = includeHistory
    ? listDispatchAttemptsByState(
        ["completed", "failed", "timed_out", "cancelled", "reconciled"],
        provider,
        { limit: Math.max(1, Math.min(500, Number(terminalLimit) || 100)) },
      )
    : [];

  const mode = deriveDispatcherMode(settings);
  const defaultAdmission =
    settings.codexDefaultAdmissionPolicy || "legacy";

  const base = {
    provider,
    mode,
    view,
    generatedAt: new Date().toISOString(),
    settings: {
      dispatcherEnabled: settings.dispatcherEnabled === true,
      dispatcherShadowMode: settings.dispatcherShadowMode === true,
      dispatcherCodexOnly: settings.dispatcherCodexOnly !== false,
      codexDefaultAdmissionPolicy: defaultAdmission,
      // Admission is API-key only: production=managed, coding=legacy
      admissionRule:
        "API key production → managed; coding → legacy. Same for Codex, Antigravity, Grok CLI.",
      dispatcherSlotsPerConnection:
        Number(
          settings[`dispatcherSlotsPerConnection_${provider}`] ??
            settings.dispatcherSlotsPerConnection,
        ) || 1,
    },
    coverage: {
      summary:
        "Managed vs legacy is decided only by the caller's API key type (production vs coding). Provider filter below is for capacity/accounts, not a separate admission policy.",
      managedOnly: true,
      mixedModeAware: true,
      admissionByApiKey: true,
      defaultAdmissionPolicy: defaultAdmission,
      runtimeMode: mode,
    },
  };

  if (includeLive) {
    base.capacity = buildCapacitySummary({
      connectionViews,
      settings,
      inMemory,
      activeAttempts,
    });
    base.queued = summarizeQueuedRequests(queuedRequests);
    base.active = summarizeActiveAttempts(activeAttempts);
    base.connections = summarizeConnections({
      connectionViews,
      settings,
      inMemory,
      activeAttempts,
      terminalAttempts: [],
    });
  }

  if (includeHistory) {
    base.terminal = summarizeTerminalAttempts(terminalAttempts);
    base.terminalLimit = Math.max(
      1,
      Math.min(500, Number(terminalLimit) || 100),
    );
  }

  if (includeLive && includeHistory) {
    base.models = summarizeModels(
      queuedRequests,
      activeAttempts,
      terminalAttempts,
    );
    base.paths = summarizePaths(activeAttempts, terminalAttempts);
    // Recompute connections with terminal for full view
    base.connections = summarizeConnections({
      connectionViews,
      settings,
      inMemory,
      activeAttempts,
      terminalAttempts,
    });
  }

  return base;
}
