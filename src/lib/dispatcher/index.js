import { getProviderConnections, getSettings } from "@/lib/localDb.js";
import { createDispatcherCore } from "@/lib/dispatcher/core.js";
import { createDispatcherWatchdog } from "@/lib/dispatcher/watchdog.js";
import { buildDispatchConnectionView } from "@/lib/dispatcher/connectionState.js";
import {
  getDispatcherSlotsPerConnection,
  TEXT_DISPATCH_PROVIDERS,
} from "@/lib/dispatcher/settings.js";
import {
  CONNECTION_CACHE_TTL_MS,
  getConnectionCacheEntry,
  setConnectionCacheEntry,
  invalidateDispatcherConnectionCache,
} from "@/lib/dispatcher/connectionCache.js";
import {
  insertDispatchAttemptEvent,
  listActiveDispatchAttempts,
  transitionDispatchAttempt,
  updateDispatchRequestStatus,
} from "@/lib/sqlite/dispatcherStore.js";
import { nowIso } from "@/lib/sqlite/helpers.js";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_TERMINAL_REASON,
  DISPATCH_ATTEMPT_STATE,
  DISPATCH_EVENT_TYPE,
  DISPATCH_REQUEST_STATUS,
} from "@/lib/dispatcher/types.js";

export { TEXT_DISPATCH_PROVIDERS, invalidateDispatcherConnectionCache };

const dispatcherByProvider = new Map();
const lastKnownSlotsByProvider = new Map();
const watchdogSweepInFlightByProvider = new Map();
let sharedWatchdogInterval = null;

const WATCHDOG_SWEEP_INTERVAL_MS = 5000;

async function loadProviderConnections(provider, { force = false } = {}) {
  const now = Date.now();
  const cached = getConnectionCacheEntry(provider);
  if (
    !force &&
    cached &&
    now - cached.at < CONNECTION_CACHE_TTL_MS &&
    Array.isArray(cached.connections)
  ) {
    lastKnownSlotsByProvider.set(provider, cached.slotsPerConnection);
    return {
      connections: cached.connections,
      slotsPerConnection: cached.slotsPerConnection,
    };
  }

  const settings = await getSettings();
  // Per-provider isolation: never fall back to another provider's slots.
  const slotsPerConnection = getDispatcherSlotsPerConnection(
    settings,
    provider,
  );
  lastKnownSlotsByProvider.set(provider, slotsPerConnection);

  const query = {
    provider,
    isActive: true,
  };
  // Codex can scope to a text dispatcher collection; others use all active accounts
  if (provider === "codex" && settings.textDispatcherCollectionId) {
    query.collectionId = settings.textDispatcherCollectionId;
  }

  let rawConnections = await getProviderConnections(query);
  // If collection filter yields zero accounts, fall back to all active provider
  // connections so managed traffic does not hang with a valid login outside the collection.
  if (
    rawConnections.length === 0 &&
    provider === "codex" &&
    settings.textDispatcherCollectionId
  ) {
    console.warn(
      `[DISPATCHER] codex: collection ${settings.textDispatcherCollectionId} has no active connections; falling back to all active Codex accounts`,
    );
    rawConnections = await getProviderConnections({
      provider: "codex",
      isActive: true,
    });
  }
  const connections = await Promise.all(
    rawConnections.map((connection) => buildDispatchConnectionView(connection)),
  );
  setConnectionCacheEntry(provider, {
    at: now,
    connections,
    slotsPerConnection,
  });
  return { connections, slotsPerConnection };
}

/**
 * Only clear *stale* active attempts when a dispatcher pool is first created
 * in this process.
 *
 * CRITICAL: Next may load routes in separate module instances / workers that
 * each call getProviderDispatcher. Naively reconciling ALL open attempts on
 * every pool create kills live work owned by another instance (user log:
 * 5 admissions → open dashboard → "reconciled 5 orphaned" → tasks never run).
 *
 * - Do not touch young attempts (other worker may own them).
 * - Do not cancel queued waiters (they are not process-local).
 * - Watchdog still times out true zombies via connect/ttft/idle/deadline.
 */
const RECONCILE_STALE_AFTER_MS = 2 * 60 * 1000;

function attemptActivityAgeMs(attempt, now = Date.now()) {
  const stamps = [
    attempt?.lastProgressAt,
    attempt?.firstProgressAt,
    attempt?.streamStartedAt,
    attempt?.connectStartedAt,
    attempt?.leasedAt,
    attempt?.queueEnteredAt,
  ];
  for (const stamp of stamps) {
    if (!stamp) continue;
    const ms = new Date(stamp).getTime();
    if (Number.isFinite(ms)) return Math.max(0, now - ms);
  }
  return Number.POSITIVE_INFINITY;
}

function reconcileOrphanedRuntime(provider) {
  const now = Date.now();
  const active = listActiveDispatchAttempts(provider);
  let reconciled = 0;
  let skippedFresh = 0;

  for (const attempt of active) {
    if (!attempt?.id) continue;
    const ageMs = attemptActivityAgeMs(attempt, now);
    if (ageMs < RECONCILE_STALE_AFTER_MS) {
      skippedFresh += 1;
      continue;
    }

    const updated = transitionDispatchAttempt(
      attempt.id,
      [
        DISPATCH_ATTEMPT_STATE.LEASED,
        DISPATCH_ATTEMPT_STATE.CONNECTING,
        DISPATCH_ATTEMPT_STATE.STREAMING,
      ],
      DISPATCH_ATTEMPT_STATE.RECONCILED,
      {
        finishedAt: nowIso(),
        terminalReason: DEFAULT_TERMINAL_REASON.RECONCILED,
        error: {
          code: "stale_after_process_start",
          message: `Active attempt older than ${RECONCILE_STALE_AFTER_MS}ms with no owning process; freed capacity`,
          ageMs,
        },
      },
    );
    if (!updated) continue;
    reconciled += 1;
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId: attempt.id,
      eventType: DISPATCH_EVENT_TYPE.RECONCILED,
      payload: { reason: "stale_after_process_start", ageMs },
    });
    if (attempt.requestId) {
      updateDispatchRequestStatus(
        attempt.requestId,
        DISPATCH_REQUEST_STATUS.CANCELLED,
        { completedAt: nowIso() },
      );
    }
  }

  if (reconciled > 0 || skippedFresh > 0) {
    console.log(
      `[DISPATCHER] ${provider}: startup reconcile stale=${reconciled} skipped_fresh=${skippedFresh} (fresh < ${RECONCILE_STALE_AFTER_MS}ms kept alive)`,
    );
  }
  return reconciled;
}

async function runWatchdogSweep(provider, entry) {
  if (watchdogSweepInFlightByProvider.get(provider)) return;
  watchdogSweepInFlightByProvider.set(provider, true);
  try {
    const result = await entry.watchdog.runSweep();
    if (result.timedOut.length > 0) {
      const byKind = {};
      for (const item of result.timedOut) {
        const kind = item.timeoutKind || "unknown";
        byKind[kind] = (byKind[kind] || 0) + 1;
      }
      const kindSummary = Object.entries(byKind)
        .map(([kind, count]) => `${kind}=${count}`)
        .join(" ");
      console.log(
        `[DISPATCHER] watchdog timed out ${result.timedOut.length} ${provider} attempt(s) (${kindSummary})`,
      );
    }
  } catch (error) {
    console.error(`[DISPATCHER] ${provider} watchdog sweep failed:`, error);
  } finally {
    watchdogSweepInFlightByProvider.set(provider, false);
  }
}

function ensureSharedWatchdogInterval() {
  if (sharedWatchdogInterval) return;
  sharedWatchdogInterval = setInterval(() => {
    for (const [provider, entry] of dispatcherByProvider) {
      runWatchdogSweep(provider, entry).catch(() => {});
    }
  }, WATCHDOG_SWEEP_INTERVAL_MS);
  sharedWatchdogInterval.unref?.();
}

/**
 * Get or create an isolated text dispatcher for a provider.
 */
export function getProviderDispatcher(provider) {
  if (!TEXT_DISPATCH_PROVIDERS.includes(provider)) {
    throw new Error(`No text dispatcher for provider: ${provider}`);
  }

  if (dispatcherByProvider.has(provider)) {
    return dispatcherByProvider.get(provider);
  }

  lastKnownSlotsByProvider.set(provider, 1);

  const dispatcher = createDispatcherCore({
    provider,
    getConnections: async () => {
      const { connections } = await loadProviderConnections(provider);
      return connections;
    },
    getSlotsPerConnection: () => lastKnownSlotsByProvider.get(provider) || 1,
  });

  const watchdog = createDispatcherWatchdog({
    provider,
    dispatcher,
  });

  const entry = {
    dispatcher,
    watchdog,
    runWatchdogSweep: () => runWatchdogSweep(provider, entry),
    async getConnections() {
      const { connections, slotsPerConnection } =
        await loadProviderConnections(provider);
      lastKnownSlotsByProvider.set(provider, slotsPerConnection);
      return connections;
    },
  };

  // Close zombies BEFORE any lease plan reads occupancy from SQLite.
  reconcileOrphanedRuntime(provider);
  dispatcherByProvider.set(provider, entry);
  ensureSharedWatchdogInterval();
  return entry;
}

/** Backward-compatible Codex accessor */
export function getCodexDispatcher() {
  return getProviderDispatcher("codex");
}
