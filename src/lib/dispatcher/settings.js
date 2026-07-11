export const DISPATCHER_MODE = {
  OFF: "off",
  SHADOW: "shadow",
  MANAGED: "managed",
};

/** Providers with isolated text dispatcher pools */
export const TEXT_DISPATCH_PROVIDERS = ["codex", "antigravity", "grok-cli"];

const VALID_MODES = new Set(Object.values(DISPATCHER_MODE));
const TEXT_DISPATCH_PROVIDER_SET = new Set(TEXT_DISPATCH_PROVIDERS);

export function deriveDispatcherMode(settings = {}) {
  if (settings.dispatcherEnabled === true) {
    return DISPATCHER_MODE.MANAGED;
  }
  if (settings.dispatcherShadowMode === true) {
    return DISPATCHER_MODE.SHADOW;
  }
  return DISPATCHER_MODE.OFF;
}

export function buildDispatcherModePatch(mode) {
  if (!VALID_MODES.has(mode)) {
    throw new Error(`Unsupported dispatcher mode: ${mode}`);
  }

  if (mode === DISPATCHER_MODE.MANAGED) {
    return {
      dispatcherEnabled: true,
      dispatcherShadowMode: false,
    };
  }

  if (mode === DISPATCHER_MODE.SHADOW) {
    return {
      dispatcherEnabled: false,
      dispatcherShadowMode: true,
    };
  }

  return {
    dispatcherEnabled: false,
    dispatcherShadowMode: false,
  };
}

/** Soft UI/API clamp — not a provider-imposed service limit. */
export const MAX_DISPATCHER_SLOTS_PER_CONNECTION = 100;

function normalizeSlotsPerConnection(
  value,
  settingName,
  max = MAX_DISPATCHER_SLOTS_PER_CONNECTION,
) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > max) {
    throw new Error(`${settingName} must be an integer between 1 and ${max}`);
  }
  return numeric;
}

export function normalizeDispatcherSlotsPerConnection(
  value,
  max = MAX_DISPATCHER_SLOTS_PER_CONNECTION,
) {
  return normalizeSlotsPerConnection(
    value,
    "dispatcherSlotsPerConnection",
    max,
  );
}

export function normalizeImageDispatcherSlotsPerConnection(
  value,
  max = MAX_DISPATCHER_SLOTS_PER_CONNECTION,
) {
  return normalizeSlotsPerConnection(
    value,
    "imageDispatcherSlotsPerConnection",
    max,
  );
}

function clampSlotsOrDefault(value, fallback = 1) {
  const numeric = Number(value);
  if (
    Number.isInteger(numeric) &&
    numeric >= 1 &&
    numeric <= MAX_DISPATCHER_SLOTS_PER_CONNECTION
  ) {
    return numeric;
  }
  return fallback;
}

/**
 * Build isolated slots-per-connection map for every text dispatch provider.
 * Providers never inherit another provider's value.
 * Codex may still seed from legacy dispatcherSlotsPerConnection on first read.
 */
export function normalizeDispatcherSlotsByProvider(
  input = {},
  legacyCodexSlots = undefined,
) {
  const source =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const codexLegacy = clampSlotsOrDefault(legacyCodexSlots, 1);
  const next = {};
  for (const provider of TEXT_DISPATCH_PROVIDERS) {
    if (source[provider] !== undefined && source[provider] !== null) {
      next[provider] = clampSlotsOrDefault(source[provider], 1);
    } else if (provider === "codex") {
      next[provider] = codexLegacy;
    } else {
      next[provider] = 1;
    }
  }
  return next;
}

/**
 * Resolve slots for one provider only. No cross-provider fallback.
 */
export function getDispatcherSlotsPerConnection(settings = {}, provider) {
  if (!TEXT_DISPATCH_PROVIDER_SET.has(provider)) {
    return 1;
  }
  const map = normalizeDispatcherSlotsByProvider(
    settings.dispatcherSlotsByProvider,
    settings.dispatcherSlotsPerConnection,
  );
  return map[provider] ?? 1;
}

/**
 * Patch one provider's slots into a full map. Other providers stay unchanged.
 */
export function patchDispatcherSlotsForProvider(
  settings = {},
  provider,
  value,
) {
  if (!TEXT_DISPATCH_PROVIDER_SET.has(provider)) {
    throw new Error(`Unknown text dispatch provider: ${provider}`);
  }
  const slots = normalizeDispatcherSlotsPerConnection(value);
  const nextMap = {
    ...normalizeDispatcherSlotsByProvider(
      settings.dispatcherSlotsByProvider,
      settings.dispatcherSlotsPerConnection,
    ),
    [provider]: slots,
  };
  return {
    dispatcherSlotsByProvider: nextMap,
    // Keep legacy column as codex mirror for older readers / backups.
    dispatcherSlotsPerConnection: nextMap.codex,
  };
}

export function isTextDispatchProvider(provider) {
  return TEXT_DISPATCH_PROVIDER_SET.has(provider);
}
