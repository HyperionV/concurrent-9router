import {
  deriveDispatcherMode,
  TEXT_DISPATCH_PROVIDERS,
} from "@/lib/dispatcher/settings.js";

const LEGACY = "legacy";
const MANAGED = "managed";
const NO_KEY_SCOPE = "__no_key__";

/** Providers that can enter managed text admission */
export function isTextDispatchProvider(provider) {
  return TEXT_DISPATCH_PROVIDERS.includes(provider);
}

/**
 * Single global default for all text-dispatch providers (Codex, AG, Grok CLI).
 * Stored as settings.codexDefaultAdmissionPolicy for backward compatibility.
 */
export function getDefaultAdmissionPolicy(settings = {}) {
  return settings.codexDefaultAdmissionPolicy || LEGACY;
}

/** @deprecated use getDefaultAdmissionPolicy — kept for call-site compatibility */
export function getDefaultAdmissionPolicyForProvider(settings = {}, _provider) {
  return getDefaultAdmissionPolicy(settings);
}

function normalizePolicy(value, { allowInherit = false } = {}) {
  if (value == null || value === "") return allowInherit ? null : LEGACY;
  if (value === "inherit") {
    if (allowInherit) return null;
    throw new Error("Global admission policy cannot be inherit");
  }
  if (value === LEGACY || value === MANAGED) return value;
  throw new Error(`Unsupported admission policy: ${value}`);
}

export function normalizeCodexAdmissionPolicyOverride(value) {
  return normalizePolicy(value, { allowInherit: true });
}

export function normalizeCodexDefaultAdmissionPolicy(value) {
  return normalizePolicy(value, { allowInherit: false });
}

export function getApiKeyScope(apiKeyId = null) {
  return apiKeyId || NO_KEY_SCOPE;
}

/**
 * Resolve admission for any text-dispatch provider.
 *
 * Only rule:
 * - API key coding  → legacy  (codexAdmissionPolicyOverride = "legacy")
 * - API key production → managed (codexAdmissionPolicyOverride = "managed")
 * - No key override → global default (codexDefaultAdmissionPolicy)
 *
 * Same rule for Codex, Antigravity, and Grok CLI. No per-provider pool policies.
 */
export function computeCodexAdmissionDecision({
  runtimeMode = "off",
  defaultPolicy = LEGACY,
  apiKeyRecord = null,
  hasManagedAffinity = false,
} = {}) {
  if (apiKeyRecord && apiKeyRecord.isActive === false) {
    throw new Error("Inactive API key cannot resolve admission policy");
  }

  const requestedPolicy = apiKeyRecord
    ? normalizeCodexAdmissionPolicyOverride(
        apiKeyRecord.codexAdmissionPolicyOverride,
      ) || normalizeCodexDefaultAdmissionPolicy(defaultPolicy)
    : normalizeCodexDefaultAdmissionPolicy(defaultPolicy);

  const policySource = apiKeyRecord?.codexAdmissionPolicyOverride
    ? "key_override"
    : "global_default";

  let effectiveBehavior = LEGACY;
  let shadowTracked = false;

  if (runtimeMode === "managed") {
    effectiveBehavior =
      requestedPolicy === MANAGED || hasManagedAffinity ? MANAGED : LEGACY;
  } else if (runtimeMode === "shadow") {
    effectiveBehavior = LEGACY;
    shadowTracked = requestedPolicy === MANAGED;
  }

  return {
    runtimeMode,
    requestedPolicy,
    policySource,
    effectiveBehavior,
    shadowTracked,
    hasManagedAffinity: hasManagedAffinity === true,
    apiKeyId: apiKeyRecord?.id || null,
    apiKeyScope: getApiKeyScope(apiKeyRecord?.id || null),
  };
}

export function computeCodexAdmissionDecisionFromSettings({
  settings = {},
  apiKeyRecord = null,
  hasManagedAffinity = false,
  provider = "codex",
} = {}) {
  void provider; // same policy for all text-dispatch providers
  return computeCodexAdmissionDecision({
    runtimeMode: deriveDispatcherMode(settings),
    defaultPolicy: getDefaultAdmissionPolicy(settings),
    apiKeyRecord,
    hasManagedAffinity,
  });
}

/** Alias for multi-provider call sites */
export const computeAdmissionDecisionFromSettings =
  computeCodexAdmissionDecisionFromSettings;
