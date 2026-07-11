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
 * Default admission policy for a provider.
 * Codex uses codexDefaultAdmissionPolicy; AG/Grok default to legacy unless
 * settings.providerAdmissionPolicies[provider] opts into managed.
 */
export function getDefaultAdmissionPolicyForProvider(settings = {}, provider = "codex") {
  if (provider === "codex") {
    return settings.codexDefaultAdmissionPolicy || LEGACY;
  }
  const map = settings.providerAdmissionPolicies || {};
  return map[provider] || LEGACY;
}

function normalizePolicy(value, { allowInherit = false } = {}) {
  if (value == null || value === "") return allowInherit ? null : LEGACY;
  if (value === "inherit") {
    if (allowInherit) return null;
    throw new Error("Global Codex admission policy cannot be inherit");
  }
  if (value === LEGACY || value === MANAGED) return value;
  throw new Error(`Unsupported Codex admission policy: ${value}`);
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

export function computeCodexAdmissionDecision({
  runtimeMode = "off",
  defaultPolicy = LEGACY,
  apiKeyRecord = null,
  hasManagedAffinity = false,
} = {}) {
  if (apiKeyRecord && apiKeyRecord.isActive === false) {
    throw new Error("Inactive API key cannot resolve Codex admission policy");
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
  return computeCodexAdmissionDecision({
    runtimeMode: deriveDispatcherMode(settings),
    defaultPolicy: getDefaultAdmissionPolicyForProvider(settings, provider),
    apiKeyRecord,
    hasManagedAffinity,
  });
}

/** Alias for multi-provider call sites */
export const computeAdmissionDecisionFromSettings =
  computeCodexAdmissionDecisionFromSettings;
