import { getProviderConnections, getSettings } from "@/lib/localDb.js";
import { createDispatcherCore } from "@/lib/dispatcher/core.js";
import { createDispatcherWatchdog } from "@/lib/dispatcher/watchdog.js";
import { buildDispatchConnectionView } from "@/lib/dispatcher/connectionState.js";
import { TEXT_DISPATCH_PROVIDERS } from "@/lib/dispatcher/settings.js";

export { TEXT_DISPATCH_PROVIDERS };

const dispatcherByProvider = new Map();
const lastKnownSlotsByProvider = new Map();
const watchdogSweepInFlightByProvider = new Map();
let sharedWatchdogInterval = null;

const WATCHDOG_SWEEP_INTERVAL_MS = 5000;

function slotsSettingKey(provider) {
  if (provider === "codex") return "dispatcherSlotsPerConnection";
  return `dispatcherSlotsPerConnection_${provider}`;
}

async function loadProviderConnections(provider) {
  const settings = await getSettings();
  const slotsKey = slotsSettingKey(provider);
  const slotsPerConnection =
    settings[slotsKey] ?? settings.dispatcherSlotsPerConnection ?? 1;
  lastKnownSlotsByProvider.set(provider, slotsPerConnection);

  const query = {
    provider,
    isActive: true,
  };
  // Codex can scope to a text dispatcher collection; others use all active accounts
  if (provider === "codex" && settings.textDispatcherCollectionId) {
    query.collectionId = settings.textDispatcherCollectionId;
  }

  const rawConnections = await getProviderConnections(query);
  const connections = await Promise.all(
    rawConnections.map((connection) => buildDispatchConnectionView(connection)),
  );
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
