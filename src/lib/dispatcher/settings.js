export const DISPATCHER_MODE = {
  OFF: "off",
  SHADOW: "shadow",
  MANAGED: "managed",
};

const VALID_MODES = new Set(Object.values(DISPATCHER_MODE));

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

export function normalizeDispatcherSlotsPerConnection(value, max = 20) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > max) {
    throw new Error(
      `dispatcherSlotsPerConnection must be an integer between 1 and ${max}`,
    );
  }
  return numeric;
}
