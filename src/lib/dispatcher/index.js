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
  getLatestDispatchAttemptForRequest,
  insertDispatchAttemptEvent,
  listActiveDispatchAttempts,
  listQueuedDispatchRequests,
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
 * After process restart, SQLite still holds leased/connecting/streaming rows
 * from the previous process. Occupancy is rebuilt from those zombies, which
 * blocks real traffic until the watchdog times them out (looks like "idle
 * timeouts" right after start). Must run synchronously on pool create.
 */
function reconcileOrphanedRuntime(provider) {
  const openAttempts = [
    ...listActiveDispatchAttempts(provider),
    ...listQueuedDispatchRequests(provider, 500)
      .map((request) => getLatestDispatchAttemptForRequest(request.id))
      .filter(
        (attempt) =>
          attempt && attempt.state === DISPATCH_ATTEMPT_STATE.QUEUED,
      ),
  ];

  // Dedupe by attempt id
  const seen = new Set();
  let reconciled = 0;
  for (const attempt of openAttempts) {
    if (!attempt?.id || seen.has(attempt.id)) continue;
    seen.add(attempt.id);
    const updated = transitionDispatchAttempt(
      attempt.id,
      [
        DISPATCH_ATTEMPT_STATE.QUEUED,
        DISPATCH_ATTEMPT_STATE.LEASED,
        DISPATCH_ATTEMPT_STATE.CONNECTING,
        DISPATCH_ATTEMPT_STATE.STREAMING,
      ],
      DISPATCH_ATTEMPT_STATE.RECONCILED,
      {
        finishedAt: nowIso(),
        terminalReason: DEFAULT_TERMINAL_REASON.RECONCILED,
        error: {
          code: "process_restart",
          message:
            "Open after process restart; reconciled so capacity is free",
        },
      },
    );
    if (!updated) continue;
    reconciled += 1;
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId: attempt.id,
      eventType: DISPATCH_EVENT_TYPE.RECONCILED,
      payload: { reason: "process_restart" },
    });
    if (attempt.requestId) {
      updateDispatchRequestStatus(
        attempt.requestId,
        DISPATCH_REQUEST_STATUS.CANCELLED,
        { completedAt: nowIso() },
      );
    }
  }

  if (reconciled > 0) {
    console.log(
      `[DISPATCHER] ${provider}: reconciled ${reconciled} orphaned attempt(s) after process start`,
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
