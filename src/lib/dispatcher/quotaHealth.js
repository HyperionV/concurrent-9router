import { updateProviderConnection } from "@/lib/localDb.js";

const NORMAL_QUOTA_TTL_MS = 5 * 60 * 1000;
const DANGER_ZONE_QUOTA_TTL_MS = 30 * 1000;
const DANGER_ZONE_REMAINING_FRACTION = 0.05;
const QUOTA_NAMESPACE = "dispatcherQuotaHealth";

function normalizeModelId(modelId) {
  return typeof modelId === "string" && modelId.trim()
    ? modelId.trim()
    : "__all";
}

function getQuotaState(connection, modelId) {
  const rawConnection = connection?._connection || connection;
  const quota = rawConnection?.providerSpecificData?.[QUOTA_NAMESPACE] || {};
  return quota[normalizeModelId(modelId)] || quota.__all || null;
}

function cloneProviderSpecificData(connection) {
  const rawConnection = connection?._connection || connection;
  return { ...(rawConnection?.providerSpecificData || {}) };
}

function isActiveLimitedState(state, now) {
  return (
    state?.status === "limited" &&
    Number.isFinite(state.resetsAtMs) &&
    state.resetsAtMs > now
  );
}

function buildModelLockKey(modelId) {
  return `modelLock_${normalizeModelId(modelId)}`;
}

export function createDispatcherQuotaHealth({
  now = Date.now,
  updateConnection = updateProviderConnection,
} = {}) {
  const memory = new Map();

  function cacheKey(connectionId, modelId) {
    return `${connectionId}:${normalizeModelId(modelId)}`;
  }

  function readState(connection, request = {}) {
    const connectionId = connection?.id || connection?.connectionId;
    const modelId = normalizeModelId(request?.modelId);
    if (!connectionId) return null;
    return (
      memory.get(cacheKey(connectionId, modelId)) ||
      getQuotaState(connection, modelId)
    );
  }

  function canServeRequest(connection, request = {}) {
    const state = readState(connection, request);
    return !isActiveLimitedState(state, now());
  }

  function getSelectionPenalty(connection, request = {}) {
    const state = readState(connection, request);
    const currentTime = now();
    if (isActiveLimitedState(state, currentTime))
      return Number.POSITIVE_INFINITY;
    if (
      state?.status === "danger" ||
      Number(state?.remainingFraction) <= DANGER_ZONE_REMAINING_FRACTION
    ) {
      return 1000;
    }
    return 0;
  }

  function shouldRefreshQuota(connection, request = {}) {
    const state = readState(connection, request);
    if (!state?.nextCheckAt) return true;
    return Number(state.nextCheckAt) <= now();
  }

  async function recordQuotaSnapshot({
    connectionId,
    modelId,
    remainingFraction,
    providerSpecificData = {},
    persist = false,
  }) {
    if (!connectionId) return null;
    const normalizedModelId = normalizeModelId(modelId);
    const currentTime = now();
    const safeRemaining = Number.isFinite(Number(remainingFraction))
      ? Math.max(0, Math.min(1, Number(remainingFraction)))
      : null;
    const status =
      safeRemaining != null && safeRemaining <= DANGER_ZONE_REMAINING_FRACTION
        ? "danger"
        : "ok";
    const ttlMs =
      status === "danger" ? DANGER_ZONE_QUOTA_TTL_MS : NORMAL_QUOTA_TTL_MS;
    const state = {
      status,
      remainingFraction: safeRemaining,
      checkedAt: currentTime,
      nextCheckAt: currentTime + ttlMs,
      source: "snapshot",
    };
    memory.set(cacheKey(connectionId, normalizedModelId), state);
    if (persist && typeof updateConnection === "function") {
      await updateConnection(connectionId, {
        providerSpecificData: {
          ...providerSpecificData,
          [QUOTA_NAMESPACE]: {
            ...(providerSpecificData[QUOTA_NAMESPACE] || {}),
            [normalizedModelId]: state,
          },
        },
      });
    }
    return state;
  }

  async function recordOutOfQuota({
    connectionId,
    modelId,
    resetsAtMs,
    status = 429,
    error = "usage_limit_reached",
    providerSpecificData = {},
  }) {
    if (!connectionId) return null;
    const normalizedModelId = normalizeModelId(modelId);
    const currentTime = now();
    const resetTime =
      Number.isFinite(Number(resetsAtMs)) && Number(resetsAtMs) > currentTime
        ? Number(resetsAtMs)
        : currentTime + DANGER_ZONE_QUOTA_TTL_MS;
    const state = {
      status: "limited",
      remainingFraction: 0,
      checkedAt: currentTime,
      nextCheckAt: resetTime,
      resetsAtMs: resetTime,
      source: "provider_error",
    };
    memory.set(cacheKey(connectionId, normalizedModelId), state);
    if (typeof updateConnection === "function") {
      await updateConnection(connectionId, {
        [buildModelLockKey(normalizedModelId)]: new Date(
          resetTime,
        ).toISOString(),
        testStatus: "unavailable",
        lastError:
          typeof error === "string"
            ? error.slice(0, 100)
            : "usage_limit_reached",
        errorCode: status,
        lastErrorAt: new Date(currentTime).toISOString(),
        providerSpecificData: {
          ...providerSpecificData,
          [QUOTA_NAMESPACE]: {
            ...(providerSpecificData[QUOTA_NAMESPACE] || {}),
            [normalizedModelId]: state,
          },
        },
      });
    }
    return state;
  }

  return {
    canServeRequest,
    getSelectionPenalty,
    shouldRefreshQuota,
    recordQuotaSnapshot,
    recordOutOfQuota,
  };
}

export const dispatcherQuotaHealth = createDispatcherQuotaHealth();
