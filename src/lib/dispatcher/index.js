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
import { clearZombieAttemptsOnProcessBoot } from "@/lib/dispatcher/processBootClean.js";

export { TEXT_DISPATCH_PROVIDERS, invalidateDispatcherConnectionCache };

// Process-global maps: Next/webpack evaluates this module more than once
// ("Translators initialized" ×N). Module-local Maps split the dispatcher
// pool and occupancy view across copies — admit must share one registry.
const dispatcherByProvider = (globalThis.__dispatcherByProvider ||= new Map());
const lastKnownSlotsByProvider = (globalThis.__dispatcherLastKnownSlots ||=
  new Map());
const watchdogSweepInFlightByProvider =
  (globalThis.__dispatcherWatchdogInFlight ||= new Map());
let sharedWatchdogInterval = globalThis.__dispatcherWatchdogInterval || null;

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
  // Shared across webpack module copies (Translators initialized ×N).
  const sharedSlots = (globalThis.__dispatcherSlotsByProvider ||=
    Object.create(null));
  sharedSlots[provider] = slotsPerConnection;

  const query = {
    provider,
    isActive: true,
  };
  // Codex collection scope — skip filter for the reserved "all connections" id
  // (membership may be empty while the connection is still valid).
  const collectionId = settings.textDispatcherCollectionId;
  if (
    provider === "codex" &&
    collectionId &&
    collectionId !== "__all_connections__"
  ) {
    query.collectionId = collectionId;
  }

  let rawConnections = await getProviderConnections(query);
  if (
    rawConnections.length === 0 &&
    provider === "codex" &&
    collectionId &&
    collectionId !== "__all_connections__"
  ) {
    console.warn(
      `[DISPATCHER] codex: collection ${collectionId} has no active connections; falling back to all active Codex accounts`,
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
  if (globalThis.__dispatcherWatchdogInterval) {
    sharedWatchdogInterval = globalThis.__dispatcherWatchdogInterval;
    return;
  }
  sharedWatchdogInterval = setInterval(() => {
    for (const [provider, entry] of dispatcherByProvider) {
      runWatchdogSweep(provider, entry).catch(() => {});
    }
  }, WATCHDOG_SWEEP_INTERVAL_MS);
  sharedWatchdogInterval.unref?.();
  globalThis.__dispatcherWatchdogInterval = sharedWatchdogInterval;
}

/**
 * Get or create an isolated text dispatcher for a provider.
 */
export function getProviderDispatcher(provider) {
  if (!TEXT_DISPATCH_PROVIDERS.includes(provider)) {
    throw new Error(`No text dispatcher for provider: ${provider}`);
  }

  // Once per Node process: free pure-LEASED / stuck rows from a previous run
  // so occupancy is not full of ghosts (connect_timeout=5, zero FORMAT).
  clearZombieAttemptsOnProcessBoot();

  if (dispatcherByProvider.has(provider)) {
    return dispatcherByProvider.get(provider);
  }

  lastKnownSlotsByProvider.set(provider, 1);

  // Warm slots/connections before first lease so concurrent admits don't see slots=1.
  loadProviderConnections(provider).catch((error) => {
    console.warn(
      `[DISPATCHER] ${provider}: warm connection load failed:`,
      error?.message || error,
    );
  });

  const dispatcher = createDispatcherCore({
    provider,
    getConnections: async () => {
      const { connections } = await loadProviderConnections(provider);
      return connections;
    },
    getSlotsPerConnection: () => {
      const shared = globalThis.__dispatcherSlotsByProvider?.[provider];
      if (Number.isFinite(Number(shared)) && Number(shared) > 0) {
        return Number(shared);
      }
      return lastKnownSlotsByProvider.get(provider) || 1;
    },
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

  dispatcherByProvider.set(provider, entry);
  ensureSharedWatchdogInterval();
  return entry;
}

/** Backward-compatible Codex accessor */
export function getCodexDispatcher() {
  return getProviderDispatcher("codex");
}
