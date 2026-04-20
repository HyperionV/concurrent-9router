import { cleanupProviderConnections, getSettings } from "@/lib/localDb";
import {
  enableTunnel,
  isTunnelManuallyDisabled,
  isTunnelReconnecting,
} from "@/lib/tunnel/tunnelManager";
import {
  killCloudflared,
  isCloudflaredRunning,
  ensureCloudflared,
} from "@/lib/tunnel/cloudflared";

import os from "os";

// Multiple modules register SIGINT/SIGTERM handlers legitimately
process.setMaxListeners(20);

// Use global to survive Next.js hot reload — prevents duplicate intervals
const g = (global.__appSingleton ??= {
  signalHandlersRegistered: false,
  watchdogInterval: null,
  networkMonitorInterval: null,
  lastNetworkFingerprint: null,
  lastWatchdogTick: Date.now(),
  lastTunnelRestartAt: 0,
  tunnelRestartInProgress: false,
});

const WATCHDOG_INTERVAL_MS = 60000;
const NETWORK_CHECK_INTERVAL_MS = 5000;
const NETWORK_RESTART_COOLDOWN_MS = 30000;

/**
 * Initialize app on startup
 * - Cleanup stale data
 * - Auto-reconnect tunnel if previously enabled
 * - Register shutdown handler to kill cloudflared
 * - Start watchdog to recover tunnel after sleep/wake
 */
export async function initializeApp() {
  try {
    await cleanupProviderConnections();

    // Auto-reconnect tunnel if it was enabled before restart
    const settings = await getSettings();
    if (settings.tunnelEnabled && !isCloudflaredRunning()) {
      console.log("[InitApp] Tunnel was enabled, auto-reconnecting...");
      try {
        await enableTunnel();
        console.log("[InitApp] Tunnel reconnected");
      } catch (error) {
        console.log("[InitApp] Tunnel reconnect failed:", error.message);
      }
    }

    // Kill cloudflared on process exit (register once only)
    if (!g.signalHandlersRegistered) {
      const cleanup = () => {
        killCloudflared();
        process.exit();
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      g.signalHandlersRegistered = true;
    }

    // Pre-download cloudflared binary in background
    ensureCloudflared().catch(() => {});

    // Watchdog: recover tunnel after process crash
    startWatchdog();

    // Network monitor: detect sleep/wake + network changes → restart tunnel
    startNetworkMonitor();
  } catch (error) {
    console.error("[InitApp] Error:", error);
  }
}

/** Periodically check tunnel process health and reconnect if crashed */
function startWatchdog() {
  if (g.watchdogInterval) return;
  g.watchdogInterval = setInterval(async () => {
    try {
      if (isTunnelManuallyDisabled()) return;
      if (isTunnelReconnecting()) return;
      if (g.tunnelRestartInProgress) return;
      const settings = await getSettings();
      if (!settings.tunnelEnabled) return;
      if (isCloudflaredRunning()) return;
      console.log("[Watchdog] Tunnel process is down, attempting recovery...");
      g.tunnelRestartInProgress = true;
      try {
        await enableTunnel();
        console.log("[Watchdog] Tunnel recovered");
      } finally {
        g.tunnelRestartInProgress = false;
      }
    } catch (err) {
      console.log("[Watchdog] Recovery failed:", err.message);
    }
  }, WATCHDOG_INTERVAL_MS);

  if (g.watchdogInterval.unref) g.watchdogInterval.unref();
}

/** Get network fingerprint from active interfaces (IPv4 only) */
function getNetworkFingerprint() {
  const interfaces = os.networkInterfaces();
  const active = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (!addr.internal && addr.family === "IPv4") {
        active.push(`${name}:${addr.address}`);
      }
    }
  }
  return active.sort().join("|");
}

/** Monitor network changes + sleep/wake → kill and reconnect tunnel */
function startNetworkMonitor() {
  if (g.networkMonitorInterval) return;

  g.lastNetworkFingerprint = getNetworkFingerprint();
  g.lastWatchdogTick = Date.now();

  g.networkMonitorInterval = setInterval(async () => {
    try {
      if (isTunnelManuallyDisabled()) return;
      const settings = await getSettings();
      if (!settings.tunnelEnabled) return;

      const now = Date.now();
      const elapsed = now - g.lastWatchdogTick;
      g.lastWatchdogTick = now;

      const currentFingerprint = getNetworkFingerprint();
      const networkChanged = currentFingerprint !== g.lastNetworkFingerprint;
      const wasSleep = elapsed > NETWORK_CHECK_INTERVAL_MS * 3;

      if (networkChanged) g.lastNetworkFingerprint = currentFingerprint;

      if (!networkChanged && !wasSleep) return;

      // Skip if restart already in progress or restarted recently
      if (g.tunnelRestartInProgress) return;
      if (isTunnelReconnecting()) return;
      if (now - g.lastTunnelRestartAt < NETWORK_RESTART_COOLDOWN_MS) return;

      const reason =
        wasSleep && networkChanged
          ? "sleep/wake + network change"
          : wasSleep
            ? "sleep/wake"
            : "network change";
      console.log(`[NetworkMonitor] ${reason} detected, restarting tunnel...`);

      g.tunnelRestartInProgress = true;
      g.lastTunnelRestartAt = now;
      try {
        killCloudflared();
        await new Promise((r) => setTimeout(r, 2000));
        await enableTunnel();
        console.log("[NetworkMonitor] Tunnel restarted");
        g.lastNetworkFingerprint = getNetworkFingerprint();
      } finally {
        g.tunnelRestartInProgress = false;
      }
    } catch (err) {
      console.log("[NetworkMonitor] Tunnel restart failed:", err.message);
    }
  }, NETWORK_CHECK_INTERVAL_MS);

  if (g.networkMonitorInterval.unref) g.networkMonitorInterval.unref();
}

export default initializeApp;
