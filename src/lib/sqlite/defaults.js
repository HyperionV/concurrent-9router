export const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";

export const DEFAULT_SETTINGS = {
  requireApiKey: false,
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
  dispatcherEnabled: true,
  dispatcherShadowMode: false,
  dispatcherCodexOnly: true,
  codexDefaultAdmissionPolicy: "managed",
  // Legacy codex mirror — keep in sync with dispatcherSlotsByProvider.codex
  dispatcherSlotsPerConnection: 1,
  // Isolated slots per text dispatch provider (never shared across providers)
  dispatcherSlotsByProvider: {
    codex: 1,
    antigravity: 1,
    "grok-cli": 1,
  },
  imageDispatcherSlotsPerConnection: 1,
  textDispatcherCollectionId: null,
  imageDispatcherCollectionId: null,
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  telegramEnabled: true,
  telegramPeriodicReportEnabled: true,
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
  if (typeof source.requireApiKey === "boolean") {
    next.requireApiKey = source.requireApiKey;
  }
  if (typeof source.observabilityEnabled === "boolean") {
    next.observabilityEnabled = source.observabilityEnabled;
  }
  if (typeof source.enableTelegram === "boolean") {
    next.telegramEnabled = source.enableTelegram;
  }
  if (typeof source.telegramEnabled === "boolean") {
    next.telegramEnabled = source.telegramEnabled;
  }
  if (typeof source.telegramPeriodicReportEnabled === "boolean") {
    next.telegramPeriodicReportEnabled = source.telegramPeriodicReportEnabled;
  }

  if (
    source.outboundProxyEnabled === undefined &&
    typeof source.outboundProxyUrl === "string" &&
    source.outboundProxyUrl.trim()
  ) {
    next.outboundProxyEnabled = true;
  }

  // Dispatcher configuration is now operator-facing managed-only.
  next.dispatcherEnabled = true;
  next.dispatcherShadowMode = false;
  next.codexDefaultAdmissionPolicy = "managed";

  // Ensure per-provider slots map is complete and isolated (no shared defaults
  // across providers). Codex may seed from legacy dispatcherSlotsPerConnection.
  const slotsSource =
    source.dispatcherSlotsByProvider &&
    typeof source.dispatcherSlotsByProvider === "object"
      ? source.dispatcherSlotsByProvider
      : next.dispatcherSlotsByProvider;
  const codexSlots = Number(
    slotsSource?.codex ??
      source.dispatcherSlotsPerConnection ??
      next.dispatcherSlotsPerConnection ??
      1,
  );
  next.dispatcherSlotsByProvider = {
    codex: Number.isInteger(codexSlots) && codexSlots >= 1 ? codexSlots : 1,
    antigravity: (() => {
      const n = Number(slotsSource?.antigravity);
      return Number.isInteger(n) && n >= 1 ? n : 1;
    })(),
    "grok-cli": (() => {
      const n = Number(slotsSource?.["grok-cli"]);
      return Number.isInteger(n) && n >= 1 ? n : 1;
    })(),
  };
  next.dispatcherSlotsPerConnection = next.dispatcherSlotsByProvider.codex;

  return next;
}

export function withSettingsAliases(settings) {
  return {
    ...settings,
    enableObservability: settings.observabilityEnabled === true,
    enableTelegram: settings.telegramEnabled === true,
  };
}
