export const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

export const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  cloudUrl: "",
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  fallbackStrategy: "fill-first",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  comboStrategy: "fallback",
  comboStrategies: {},
  requireLogin: true,
  tunnelDashboardAccess: true,
  mitmEnabled: false,
  observabilityEnabled: true,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 1024,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  dispatcherEnabled: false,
  dispatcherShadowMode: false,
  dispatcherCodexOnly: true,
  dispatcherSlotsPerConnection: 1,
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
};

export function normalizeSettings(input = {}) {
  const next = { ...DEFAULT_SETTINGS };
  const source =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};

  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      next[key] = value;
    }
  }

  if (typeof source.enableObservability === "boolean") {
    next.observabilityEnabled = source.enableObservability;
  }
  if (typeof source.observabilityEnabled === "boolean") {
    next.observabilityEnabled = source.observabilityEnabled;
  }

  if (
    source.outboundProxyEnabled === undefined &&
    typeof source.outboundProxyUrl === "string" &&
    source.outboundProxyUrl.trim()
  ) {
    next.outboundProxyEnabled = true;
  }

  return next;
}

export function withSettingsAliases(settings) {
  return {
    ...settings,
    enableObservability: settings.observabilityEnabled === true,
  };
}
