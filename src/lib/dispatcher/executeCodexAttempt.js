import { getProviderConnectionById } from "@/lib/localDb.js";
import { buildManagedCredentials } from "@/lib/dispatcher/connectionState.js";
import { getProviderDispatcher } from "@/lib/dispatcher/index.js";
import { dispatcherQuotaHealth } from "@/lib/dispatcher/quotaHealth.js";
import {
  getConversationAffinity,
  persistConversationAffinity,
  resolveConversationKey,
} from "@/lib/dispatcher/conversationAffinity.js";
import {
  computeCodexAdmissionDecisionFromSettings,
  isTextDispatchProvider,
} from "@/lib/dispatcher/admissionPolicy.js";
import {
  checkAndRefreshToken,
  updateProviderCredentials,
} from "@/sse/services/tokenRefresh.js";
import {
  clearAccountError,
  markAccountUnavailable,
} from "@/sse/services/auth.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "@/sse/utils/logger.js";
import { createErrorResult } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { PROVIDERS } from "open-sse/config/providers.js";

function resolveTargetFormat(provider) {
  return PROVIDERS[provider]?.format || "openai";
}

/**
 * OPT-001: wait for central refill to assign this request.
 * Prefer waitForAssignedLease (no per-waiter tryLeaseRequest loop).
 */
async function waitForLease(dispatcher, requestId, timeoutMs) {
  if (typeof dispatcher.waitForAssignedLease === "function") {
    return dispatcher.waitForAssignedLease(requestId, timeoutMs);
  }

  // Fallback for older cores / tests that only expose tryLeaseRequest
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() <= deadline) {
    const lease = await dispatcher.tryLeaseRequest(requestId);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await dispatcher.waitForLeaseSignal?.(requestId, remaining);
  }
  return null;
}

/**
 * Managed admission for Codex, Antigravity, and Grok CLI (isolated pools).
 * Returns null when this request should use the legacy account-selection path.
 */
export async function maybeHandleManagedCodexRequest({
  body,
  provider,
  model,
  modelStr,
  request,
  clientRawRequest,
  apiKey,
  apiKeyRecord,
  settings,
  providerThinking,
  ccFilterNaming,
}) {
  if (!isTextDispatchProvider(provider)) {
    return null;
  }

  const conversationKey = resolveConversationKey({
    body,
    clientRawRequest,
  });
  const affinity = getConversationAffinity(
    conversationKey,
    apiKeyRecord?.id || null,
  );
  const decision = computeCodexAdmissionDecisionFromSettings({
    settings,
    apiKeyRecord,
    hasManagedAffinity: affinity?.state === "active",
    provider,
  });
  if (decision.effectiveBehavior !== "managed") {
    return null;
  }

  log.info(
    "DISPATCHER",
    `managed admission for ${provider}/${model} (policy=${decision.requestedPolicy})`,
  );

  return executeManagedProviderRequest({
    body,
    provider,
    model,
    modelStr,
    request,
    clientRawRequest,
    apiKey,
    apiKeyRecord,
    decision,
    providerThinking,
    ccFilterNaming,
    requestId: null,
    retryBudget: 1,
  });
}

async function executeManagedProviderRequest({
  body,
  provider,
  model,
  modelStr,
  request,
  clientRawRequest,
  apiKey,
  apiKeyRecord,
  decision,
  providerThinking,
  ccFilterNaming,
  requestId = null,
  retryBudget = 1,
}) {
  const conversationKey = resolveConversationKey({
    body,
    clientRawRequest,
  });
  const affinity = getConversationAffinity(
    conversationKey,
    apiKeyRecord?.id || null,
  );
  const { dispatcher } = getProviderDispatcher(provider);
  const targetFormat = resolveTargetFormat(provider);
  const queued = requestId
    ? await dispatcher.requeueRequest(requestId, {
        metadataPatch: {
          routeModel: modelStr,
          retryBudget,
          admission: decision,
        },
      })
    : await dispatcher.enqueueRequest({
        provider,
        modelId: model,
        sourceEndpoint: clientRawRequest?.endpoint || null,
        sourceFormat: request?.url
          ? detectFormatByEndpoint(new URL(request.url).pathname, body)
          : null,
        targetFormat,
        conversationKey,
        metadata: {
          routeModel: modelStr,
          retryBudget,
          admission: decision,
        },
      });

  if (!queued) {
    return createErrorResult(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `${provider} dispatcher could not queue request`,
    ).response;
  }

  const lease = await waitForLease(
    dispatcher,
    queued.request.id,
    dispatcher.timeoutPolicy?.queueTtlMs,
  );
  if (!lease) {
    await dispatcher.failAttempt(queued.attempt.id, {
      nextState: "timed_out",
      terminalReason: "queue_expired",
      timeoutKind: "queue_expired",
      error: { code: "dispatcher_queue_expired" },
    });
    log.warn(
      "DISPATCHER",
      `${provider}/${model}: no lease (empty connection pool, collection filter, or queue TTL). Falling back is not available on managed path.`,
    );
    return createErrorResult(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `${provider} dispatcher could not assign a connection for ${model}. Check: active ${provider} accounts, text dispatcher collection membership, and that accounts are not rate-limited.`,
    ).response;
  }

  const rawConnection = await getProviderConnectionById(lease.connectionId);
  if (!rawConnection || rawConnection.isActive !== true) {
    await dispatcher.failAttempt(lease.attemptId, {
      nextState: "failed",
      terminalReason: "connection_missing",
      error: { connectionId: lease.connectionId },
    });
    return createErrorResult(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `Managed ${provider} connection unavailable`,
    ).response;
  }

  let credentials = await buildManagedCredentials(rawConnection);
  if (affinity?.state === "active" && affinity?.sessionId) {
    credentials = {
      ...credentials,
      providerSpecificData: {
        ...(credentials.providerSpecificData || {}),
        dispatchSessionId: affinity.sessionId,
      },
    };
  }
  credentials = await checkAndRefreshToken(provider, credentials);

  let persistedContinuationKey = null;
  const dispatcherHooks = {
    onConnectStarted: async ({ pathMode = null } = {}) => {
      await dispatcher.markAttemptConnecting(lease.attemptId, { pathMode });
    },
    onStreamStarted: async () => {
      await dispatcher.markAttemptStreamStarted(lease.attemptId);
    },
    onFirstProgress: async () => {
      await dispatcher.markAttemptProgress(lease.attemptId);
    },
    onResponseIdentity: async (responseId) => {
      if (typeof responseId !== "string" || responseId.trim() === "") {
        return;
      }
      const continuationKey = responseId.trim();
      if (persistedContinuationKey === continuationKey) {
        return;
      }
      persistConversationAffinity({
        conversationKey: continuationKey,
        provider,
        modelId: model,
        connectionId: lease.connectionId,
        sessionId: credentials?.providerSpecificData?.dispatchSessionId || null,
        apiKeyId: apiKeyRecord?.id || null,
      });
      persistedContinuationKey = continuationKey;
    },
    onCompleted: async () => {
      await finalizeSuccess("success");
    },
  };

  let finalized = false;
  const finalizeSuccess = async (terminalReason = "success") => {
    if (finalized) return;
    finalized = true;
    await dispatcher.completeAttempt(lease.attemptId, { terminalReason });
  };
  const finalizeFailure = async (terminalReason, errorPayload = {}) => {
    if (finalized) return;
    finalized = true;
    await dispatcher.failAttempt(lease.attemptId, {
      nextState: "failed",
      terminalReason,
      error: errorPayload,
    });
  };

  const result = await handleChatCore({
    body: { ...body, model: `${provider}/${model}` },
    modelInfo: { provider, model },
    credentials,
    log,
    clientRawRequest,
    connectionId: credentials.connectionId,
    userAgent: request?.headers?.get("user-agent") || "",
    apiKey,
    ccFilterNaming: !!ccFilterNaming,
    providerThinking,
    routingDecision: decision,
    sourceFormatOverride: request?.url
      ? detectFormatByEndpoint(new URL(request.url).pathname, body)
      : null,
    dispatcherHooks,
    onCredentialsRefreshed: async (newCreds) => {
      await updateProviderCredentials(credentials.connectionId, {
        accessToken: newCreds.accessToken,
        refreshToken: newCreds.refreshToken,
        idToken: newCreds.idToken,
        email: newCreds.email,
        providerSpecificData: newCreds.providerSpecificData,
        testStatus: "active",
      });
    },
    onRequestSuccess: async () => {
      await clearAccountError(credentials.connectionId, credentials, model);
    },
    onDisconnect: async () => {
      await finalizeSuccess("client_disconnect");
    },
  });

  if (result.success) {
    // Non-stream JSON: finalize here (forced SSE→JSON paths never call onCompleted).
    // Streaming: do NOT finalize yet — slot stays held until stream onCompleted
    // after the body is fully consumed. Completing early would free the slot
    // while Grok is still streaming and break queueing.
    const contentType =
      result.response?.headers?.get?.("Content-Type") || "";
    if (contentType.includes("application/json")) {
      await finalizeSuccess("success");
    }
    return result.response;
  }

  if (result.status === 429 || Number.isFinite(Number(result.resetsAtMs))) {
    await dispatcherQuotaHealth.recordOutOfQuota({
      connectionId: credentials.connectionId,
      modelId: model,
      resetsAtMs: result.resetsAtMs,
      status: result.status,
      error: result.error,
      providerSpecificData: credentials.providerSpecificData || {},
    });
  }

  const { shouldFallback } = await markAccountUnavailable(
    credentials.connectionId,
    result.status,
    result.error,
    provider,
    model,
    result.resetsAtMs,
  );

  if (shouldFallback) {
    await finalizeFailure("fallback_requested", {
      status: result.status,
      message: result.error,
      resetsAtMs: result.resetsAtMs || null,
    });

    if (retryBudget > 0) {
      return executeManagedProviderRequest({
        body,
        provider,
        model,
        modelStr,
        request,
        clientRawRequest,
        apiKey,
        apiKeyRecord,
        decision,
        providerThinking,
        ccFilterNaming,
        requestId: queued.request.id,
        retryBudget: retryBudget - 1,
      });
    }
  } else {
    await finalizeFailure("upstream_error", {
      status: result.status,
      message: result.error,
    });
  }

  return (
    result.response ||
    createErrorResult(
      result.status || HTTP_STATUS.BAD_GATEWAY,
      result.error || `${provider} managed request failed`,
    ).response
  );
}
