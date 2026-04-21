import { deriveDispatcherMode } from "@/lib/dispatcher/settings.js";

const LEGACY = "legacy";
const MANAGED = "managed";
const NO_KEY_SCOPE = "__no_key__";

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
} = {}) {
  return computeCodexAdmissionDecision({
    runtimeMode: deriveDispatcherMode(settings),
    defaultPolicy: settings.codexDefaultAdmissionPolicy,
    apiKeyRecord,
    hasManagedAffinity,
  });
}
