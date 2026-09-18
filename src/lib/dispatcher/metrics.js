import {
  listActiveDispatchAttempts,
  listDispatchAttemptsByState,
  listQueuedDispatchRequests,
} from "@/lib/sqlite/dispatcherStore.js";
import {
  queryDispatcherTimeline,
  queryDispatcherAggregates,
  queryDispatcherConnectionStats,
  queryDispatcherModelStats,
  queryDispatcherLastActiveByConnection,
} from "@/lib/sqlite/dispatcherMetricsStore.js";
import {
  createEmptyHistogram,
  recordLatency,
  calculatePercentiles,
} from "@/lib/dispatcher/histogram.js";
import {
  deriveDispatcherMode,
  getDispatcherSlotsPerConnection,
  normalizeDispatcherSlotsByProvider,
} from "@/lib/dispatcher/settings.js";

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

function getAttemptLatencies(attempt) {
  let queueWaitMs = null;
  let ttftMs = null;
  let totalDurationMs = null;

  if (attempt.leasedAt && attempt.queueEnteredAt) {
    const q = Math.max(0, new Date(attempt.leasedAt).getTime() - new Date(attempt.queueEnteredAt).getTime());
    if (Number.isFinite(q)) queueWaitMs = q;
  }
  if (attempt.firstProgressAt && attempt.connectStartedAt) {
    const t = Math.max(0, new Date(attempt.firstProgressAt).getTime() - new Date(attempt.connectStartedAt).getTime());
    if (Number.isFinite(t)) ttftMs = t;
  }
  if (attempt.finishedAt && attempt.queueEnteredAt) {
    const d = Math.max(0, new Date(attempt.finishedAt).getTime() - new Date(attempt.queueEnteredAt).getTime());
    if (Number.isFinite(d)) totalDurationMs = d;
  }

  return { queueWaitMs, ttftMs, totalDurationMs };
}

function summarizeTerminalAttempts(terminalAttempts) {
  const byState = {};
  const byTimeoutKind = {};
  const byTerminalReason = {};
  const byPathMode = {};
  const ttftHist = createEmptyHistogram();
  const queueHist = createEmptyHistogram();
  let ttftSum = 0;
  let ttftCount = 0;
  let queueWaitSum = 0;
  let queueWaitCount = 0;
  let durationSum = 0;
  let durationCount = 0;

  for (const attempt of terminalAttempts) {
    increment(byState, attempt.state);
    increment(byTimeoutKind, attempt.timeoutKind);
    increment(byTerminalReason, attempt.terminalReason);
    increment(byPathMode, attempt.pathMode);

    const lat = getAttemptLatencies(attempt);
    if (lat.queueWaitMs !== null) {
      queueWaitSum += lat.queueWaitMs;
      queueWaitCount += 1;
      recordLatency(queueHist, lat.queueWaitMs);
    }
    if (lat.ttftMs !== null) {
      ttftSum += lat.ttftMs;
      ttftCount += 1;
      recordLatency(ttftHist, lat.ttftMs);
    }
    if (lat.totalDurationMs !== null) {
      durationSum += lat.totalDurationMs;
      durationCount += 1;
    }
  }

  const ttftPercentiles = calculatePercentiles(ttftHist, [50, 90, 95, 99]);
  const queuePercentiles = calculatePercentiles(queueHist, [50, 95]);

  return {
    count: terminalAttempts.length,
    byState,
    byTimeoutKind,
    byTerminalReason,
    byPathMode,
    latency: {
      avgTtftMs: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : 0,
      p50TtftMs: ttftPercentiles.p50,
      p90TtftMs: ttftPercentiles.p90,
      p95TtftMs: ttftPercentiles.p95,
      p99TtftMs: ttftPercentiles.p99,
      maxTtftMs: ttftPercentiles.max,
      avgQueueWaitMs: queueWaitCount > 0 ? Math.round(queueWaitSum / queueWaitCount) : 0,
      p50QueueWaitMs: queuePercentiles.p50,
      p95QueueWaitMs: queuePercentiles.p95,
      avgDurationMs: durationCount > 0 ? Math.round(durationSum / durationCount) : 0,
    },
  };
}

function buildCapacitySummary({
  connectionViews,
  settings,
  provider,
  inMemory,
  activeAttempts,
}) {
  const slotsPerConnection = getDispatcherSlotsPerConnection(
    settings,
    provider,
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
  const ttftHist = createEmptyHistogram();
  let ttftSum = 0;
  let ttftCount = 0;
  let queueWaitSum = 0;
  let queueWaitCount = 0;
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

    const lat = getAttemptLatencies(attempt);
    if (lat.queueWaitMs !== null) {
      queueWaitSum += lat.queueWaitMs;
      queueWaitCount += 1;
    }
    if (lat.ttftMs !== null) {
      ttftSum += lat.ttftMs;
      ttftCount += 1;
      recordLatency(ttftHist, lat.ttftMs);
    }
  }

  return {
    recentAttempts: attempts.length,
    recentTerminalReasonCounts: terminalReasonCounts,
    lastAttemptAt,
    avgTtftMs: ttftCount > 0 ? Math.round(ttftSum / ttftCount) : 0,
    p95TtftMs: calculatePercentiles(ttftHist, [95]).p95,
    avgQueueWaitMs: queueWaitCount > 0 ? Math.round(queueWaitSum / queueWaitCount) : 0,
  };
}

function summarizeConnections({
  connectionViews,
  settings,
  provider,
  inMemory,
  connectionStats = {},
}) {
  const slotsPerConnection = getDispatcherSlotsPerConnection(
    settings,
    provider,
  );
  const occupancyByConnection = inMemory?.occupancyByConnection || {};

  return [...connectionViews]
    .map((connection) => {
      const occupiedSlots = Number(occupancyByConnection[connection.id] || 0);
      const health = connectionStats[connection.id] || {
        recentAttempts: 0,
        recentTerminalReasonCounts: {},
        lastAttemptAt: null,
        avgTtftMs: 0,
        p95TtftMs: 0,
        avgQueueWaitMs: 0,
      };
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
        avgTtftMs: health.avgTtftMs,
        p95TtftMs: health.p95TtftMs,
        avgQueueWaitMs: health.avgQueueWaitMs,
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
        ttftSum: 0,
        ttftCount: 0,
        queueSum: 0,
        queueCount: 0,
        ttftHist: createEmptyHistogram(),
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

    const lat = getAttemptLatencies(attempt);
    if (lat.queueWaitMs !== null) {
      entry.queueSum += lat.queueWaitMs;
      entry.queueCount += 1;
    }
    if (lat.ttftMs !== null) {
      entry.ttftSum += lat.ttftMs;
      entry.ttftCount += 1;
      recordLatency(entry.ttftHist, lat.ttftMs);
    }
  }

  return [...byModel.values()]
    .map((m) => ({
      modelId: m.modelId,
      queued: m.queued,
      active: m.active,
      completed: m.completed,
      failed: m.failed,
      timedOut: m.timedOut,
      cancelled: m.cancelled,
      reconciled: m.reconciled,
      total: m.total,
      avgTtftMs: m.ttftCount > 0 ? Math.round(m.ttftSum / m.ttftCount) : 0,
      p95TtftMs: calculatePercentiles(m.ttftHist, [95]).p95,
      avgQueueWaitMs: m.queueCount > 0 ? Math.round(m.queueSum / m.queueCount) : 0,
    }))
    .sort((a, b) => {
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
  range = "24h",
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
  const slotsByProvider = normalizeDispatcherSlotsByProvider(
    settings.dispatcherSlotsByProvider,
    settings.dispatcherSlotsPerConnection,
  );
  const providerSlots = getDispatcherSlotsPerConnection(settings, provider);

  const base = {
    provider,
    mode,
    view,
    range,
    generatedAt: new Date().toISOString(),
    settings: {
      dispatcherEnabled: settings.dispatcherEnabled === true,
      dispatcherShadowMode: settings.dispatcherShadowMode === true,
      dispatcherCodexOnly: settings.dispatcherCodexOnly !== false,
      codexDefaultAdmissionPolicy: defaultAdmission,
      // Admission is API-key only: production=managed, coding=legacy
      admissionRule:
        "API key production → managed; coding → legacy. Same for Codex, Antigravity, Grok CLI.",
      // Slots for the selected provider only (isolated; never shared).
      dispatcherSlotsPerConnection: providerSlots,
      dispatcherSlotsByProvider: slotsByProvider,
      textDispatcherCollectionId: settings.textDispatcherCollectionId || null,
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

  const connectionStats = queryDispatcherConnectionStats({
    provider,
    range,
  });

  if (includeLive) {
    base.capacity = buildCapacitySummary({
      connectionViews,
      settings,
      provider,
      inMemory,
      activeAttempts,
    });
    base.queued = summarizeQueuedRequests(queuedRequests);
    base.active = summarizeActiveAttempts(activeAttempts);
    base.connections = summarizeConnections({
      connectionViews,
      settings,
      provider,
      inMemory,
      connectionStats,
    });
  }

  if (includeHistory) {
    base.terminal = summarizeTerminalAttempts(terminalAttempts);
    base.terminalLimit = Math.max(
      1,
      Math.min(500, Number(terminalLimit) || 100),
    );
    base.aggregates = queryDispatcherAggregates(provider);
    base.timeline = queryDispatcherTimeline({ provider, range });
    base.latency = base.terminal.latency || {
      avgTtftMs: base.aggregates.avgTtftMs,
      p50TtftMs: base.aggregates.p50TtftMs,
      p95TtftMs: base.aggregates.p95TtftMs,
      avgQueueWaitMs: base.aggregates.avgQueueWaitMs,
      p95QueueWaitMs: base.aggregates.p95QueueWaitMs,
      avgDurationMs: base.aggregates.avgDurationMs,
    };
    base.models = queryDispatcherModelStats({
      provider,
      range,
      queuedRequests,
      activeAttempts,
    });
    base.paths = summarizePaths(activeAttempts, terminalAttempts);
    if (!base.connections) {
      base.connections = summarizeConnections({
        connectionViews,
        settings,
        provider,
        inMemory,
        connectionStats,
      });
    }
  }

  return base;
}
