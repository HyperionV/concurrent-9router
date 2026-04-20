import { getProviderConnections, getSettings } from "@/lib/localDb.js";
import { createDispatcherCore } from "@/lib/dispatcher/core.js";
import { createDispatcherWatchdog } from "@/lib/dispatcher/watchdog.js";
import { buildDispatchConnectionView } from "@/lib/dispatcher/connectionState.js";

let codexDispatcherSingleton = null;
let lastKnownSlotsPerConnection = 1;
let watchdogInterval = null;
let watchdogSweepInFlight = false;

const WATCHDOG_SWEEP_INTERVAL_MS = 5000;

async function loadCodexConnections() {
  const settings = await getSettings();
  const slotsPerConnection = settings.dispatcherSlotsPerConnection ?? 1;
  lastKnownSlotsPerConnection = slotsPerConnection;
  const rawConnections = await getProviderConnections({
    provider: "codex",
    isActive: true,
  });
  const connections = await Promise.all(
    rawConnections.map((connection) => buildDispatchConnectionView(connection)),
  );
  return { connections, slotsPerConnection };
}

export function getCodexDispatcher() {
  if (codexDispatcherSingleton) return codexDispatcherSingleton;

  const dispatcher = createDispatcherCore({
    provider: "codex",
    getConnections: async () => {
      const { connections } = await loadCodexConnections();
      return connections;
    },
    getSlotsPerConnection: () => {
      return lastKnownSlotsPerConnection;
    },
  });

  const watchdog = createDispatcherWatchdog({
    provider: "codex",
    dispatcher,
  });

  async function runWatchdogSweep() {
    if (watchdogSweepInFlight) return;
    watchdogSweepInFlight = true;
    try {
      const result = await watchdog.runSweep();
      if (result.timedOut.length > 0) {
        console.log(
          `[DISPATCHER] watchdog timed out ${result.timedOut.length} codex attempt(s)`,
        );
      }
    } catch (error) {
      console.error("[DISPATCHER] watchdog sweep failed:", error);
    } finally {
      watchdogSweepInFlight = false;
    }
  }

  if (!watchdogInterval) {
    watchdogInterval = setInterval(() => {
      runWatchdogSweep().catch(() => {});
    }, WATCHDOG_SWEEP_INTERVAL_MS);
  }

  codexDispatcherSingleton = {
    dispatcher,
    watchdog,
    runWatchdogSweep,
    async getConnections() {
      const { connections, slotsPerConnection } = await loadCodexConnections();
      lastKnownSlotsPerConnection = slotsPerConnection;
      return connections;
    },
  };

  return codexDispatcherSingleton;
}
