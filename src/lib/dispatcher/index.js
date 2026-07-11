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

async function runWatchdogSweep(provider, entry) {
  if (watchdogSweepInFlightByProvider.get(provider)) return;
  watchdogSweepInFlightByProvider.set(provider, true);
  try {
    const result = await entry.watchdog.runSweep();
    if (result.timedOut.length > 0) {
      console.log(
        `[DISPATCHER] watchdog timed out ${result.timedOut.length} ${provider} attempt(s)`,
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

  dispatcherByProvider.set(provider, entry);
  ensureSharedWatchdogInterval();
  return entry;
}

/** Backward-compatible Codex accessor */
export function getCodexDispatcher() {
  return getProviderDispatcher("codex");
}
