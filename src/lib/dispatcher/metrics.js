import {
  listActiveDispatchAttempts,
  listDispatchAttemptsByState,
  listQueuedDispatchRequests,
} from "@/lib/sqlite/dispatcherStore.js";
import { getMetricsDb } from "@/lib/sqlite/dispatcherMetrics/db.js";
import { readRolledUntil } from "@/lib/sqlite/dispatcherMetrics/source.js";
import { resolveMetricsWindow } from "@/lib/sqlite/dispatcherMetrics/window.js";
import { queryDispatcherAggregates } from "@/lib/sqlite/dispatcherMetrics/aggregates.js";
import { queryDispatcherTimeline } from "@/lib/sqlite/dispatcherMetrics/timeline.js";
import {
  queryAccountBreakdown,
  queryModelBreakdown,
} from "@/lib/sqlite/dispatcherMetrics/breakdowns.js";
import {
  deriveDispatcherMode,
  getDispatcherSlotsPerConnection,
  normalizeDispatcherSlotsByProvider,
} from "@/lib/dispatcher/settings.js";

/**
 * Builds the dispatcher dashboard payload in two independent halves:
 *  - live:    what is happening now (queue, leases, occupancy, latest
 *             finished attempts). Cheap; polled every few seconds.
 *  - history: everything measured over the selected range (totals vs the
 *             previous period, timeline, per-model and per-account stats).
 * The client keeps the halves apart, so neither can overwrite the other.
 */

const TERMINAL_STATES = ["completed", "failed", "timed_out", "cancelled", "reconciled"];
const QUEUE_LIST_LIMIT = 50;
const TAPE_LIMIT = 40;
const DIAGNOSTICS_SAMPLE_LIMIT = 500;

function ageMs(timestamp, nowMs) {
  const millis = timestamp ? new Date(timestamp).getTime() : NaN;
  return Number.isFinite(millis) ? Math.max(0, nowMs - millis) : null;
}

function elapsedMs(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = item[key] || "unknown";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function connectionName(connection) {
  return connection.displayName || connection.name || connection.email || connection.id;
}

function buildSettings(settings, provider) {
  return {
    dispatcherEnabled: settings.dispatcherEnabled === true,
    dispatcherShadowMode: settings.dispatcherShadowMode === true,
    dispatcherCodexOnly: settings.dispatcherCodexOnly !== false,
    codexDefaultAdmissionPolicy: settings.codexDefaultAdmissionPolicy || "legacy",
    dispatcherSlotsPerConnection: getDispatcherSlotsPerConnection(settings, provider),
    dispatcherSlotsByProvider: normalizeDispatcherSlotsByProvider(
      settings.dispatcherSlotsByProvider,
      settings.dispatcherSlotsPerConnection,
    ),
    textDispatcherCollectionId: settings.textDispatcherCollectionId || null,
  };
}

function buildLive({ provider, settings, inMemory, connectionViews, nowMs }) {
  const queuedRequests = listQueuedDispatchRequests(provider, 500);
  const activeAttempts = listActiveDispatchAttempts(provider);
  const recentTerminal = listDispatchAttemptsByState(TERMINAL_STATES, provider, {
    limit: TAPE_LIMIT,
  });

  const slotsPerConnection = getDispatcherSlotsPerConnection(settings, provider);
  const occupancyByConnection = inMemory?.occupancyByConnection || {};
  const totalCapacity = connectionViews.length * slotsPerConnection;

  return {
    capacity: {
      slotsPerConnection,
      activeConnections: connectionViews.length,
      totalCapacity,
      activeLeases: activeAttempts.length,
      availableLeases: Math.max(0, totalCapacity - activeAttempts.length),
      utilization: totalCapacity > 0 ? activeAttempts.length / totalCapacity : 0,
    },
    queue: {
      count: queuedRequests.length,
      oldestAgeMs: ageMs(queuedRequests[0]?.queuedAt, nowMs),
      byModel: countBy(queuedRequests, "modelId"),
      requests: queuedRequests.slice(0, QUEUE_LIST_LIMIT).map((request) => ({
        id: request.id,
        modelId: request.modelId,
        sourceFormat: request.sourceFormat,
        targetFormat: request.targetFormat,
        queuedAt: request.queuedAt,
        ageMs: ageMs(request.queuedAt, nowMs),
      })),
    },
    active: {
      count: activeAttempts.length,
      byState: countBy(activeAttempts, "state"),
      byModel: countBy(activeAttempts, "modelId"),
      attempts: activeAttempts.map((attempt) => ({
        id: attempt.id,
        modelId: attempt.modelId,
        connectionId: attempt.connectionId,
        state: attempt.state,
        pathMode: attempt.pathMode,
        leasedAt: attempt.leasedAt,
        queueWaitMs: elapsedMs(attempt.queueEnteredAt, attempt.leasedAt),
        ttftMs: elapsedMs(attempt.connectStartedAt, attempt.firstProgressAt),
        runningMs: ageMs(attempt.leasedAt || attempt.queueEnteredAt, nowMs),
      })),
    },
    occupancy: connectionViews.map((connection) => ({
      connectionId: connection.id,
      connectionName: connectionName(connection),
      occupiedSlots: Number(occupancyByConnection[connection.id] || 0),
      capacity: slotsPerConnection,
    })),
    tape: recentTerminal.map((attempt) => ({
      id: attempt.id,
      modelId: attempt.modelId,
      connectionId: attempt.connectionId,
      state: attempt.state,
      terminalReason: attempt.terminalReason,
      finishedAt: attempt.finishedAt,
      queueWaitMs: elapsedMs(attempt.queueEnteredAt, attempt.leasedAt),
      ttftMs: elapsedMs(attempt.connectStartedAt, attempt.firstProgressAt),
      durationMs: elapsedMs(attempt.queueEnteredAt, attempt.finishedAt),
    })),
  };
}

function buildDiagnostics(provider) {
  const sample = listDispatchAttemptsByState(TERMINAL_STATES, provider, {
    limit: DIAGNOSTICS_SAMPLE_LIMIT,
  });
  return {
    sampleSize: sample.length,
    sampleLimit: DIAGNOSTICS_SAMPLE_LIMIT,
    oldestInSample: sample.at(-1)?.queueEnteredAt || null,
    byState: countBy(sample, "state"),
    byTerminalReason: countBy(sample, "terminalReason"),
    byTimeoutKind: countBy(
      sample.filter((attempt) => attempt.timeoutKind),
      "timeoutKind",
    ),
    byPathMode: countBy(sample, "pathMode"),
  };
}

function buildHistory({ provider, range, connectionViews, nowMs }) {
  const rolledUntilIso = readRolledUntil(getMetricsDb());
  const window = resolveMetricsWindow(range, { nowMs, rolledUntilIso });
  const previousWindow = resolveMetricsWindow(range, {
    nowMs,
    rolledUntilIso,
    periodsBack: 1,
  });

  return {
    window: {
      sinceIso: window.sinceIso,
      untilIso: window.untilIso,
      stepMs: window.stepMs,
    },
    aggregates: {
      current: queryDispatcherAggregates({ provider, window }),
      previous: queryDispatcherAggregates({ provider, window: previousWindow }),
    },
    timeline: queryDispatcherTimeline({ provider, window }),
    models: queryModelBreakdown({ provider, window }),
    accounts: queryAccountBreakdown({
      provider,
      window,
      connectionIds: connectionViews.map((connection) => connection.id),
    }),
    diagnostics: buildDiagnostics(provider),
  };
}

/**
 * @param {object} options
 * @param {"live"|"history"|"full"} options.view
 * @param {"1h"|"24h"|"7d"} options.range
 */
export function getDispatcherStatusSnapshot({
  provider,
  settings,
  inMemory,
  connectionViews,
  view,
  range,
  nowMs = Date.now(),
}) {
  const snapshot = {
    provider,
    mode: deriveDispatcherMode(settings),
    view,
    range,
    generatedAt: new Date(nowMs).toISOString(),
    settings: buildSettings(settings, provider),
  };
  if (view !== "history") {
    snapshot.live = buildLive({ provider, settings, inMemory, connectionViews, nowMs });
  }
  if (view !== "live") {
    snapshot.history = buildHistory({ provider, range, connectionViews, nowMs });
  }
  return snapshot;
}
