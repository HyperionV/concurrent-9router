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

/**
 * origin/main lease wait — poll tryLeaseRequest every 100ms.
 * Do not use evented waiters here; that path regressed concurrent Codex.
 */
const LEASE_POLL_INTERVAL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLease(dispatcher, requestId, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() <= deadline) {
    const lease = await dispatcher.tryLeaseRequest(requestId);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(LEASE_POLL_INTERVAL_MS, remaining));
  }
  return null;
}

function resolveTargetFormat(provider) {
  return PROVIDERS[provider]?.format || "openai";
}

/**
 * Managed admission for Codex, Antigravity, and Grok CLI (isolated pools).
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

  log.info(
    "DISPATCHER",
    `${provider}/${model}: waiting for lease request=${queued.request.id.slice(0, 8)}…`,
  );
  const lease = await waitForLease(
    dispatcher,
    queued.request.id,
    dispatcher.timeoutPolicy?.waitingLimitMs ??
      dispatcher.timeoutPolicy?.queueTtlMs,
  );
  if (!lease) {
    await dispatcher.failAttempt(queued.attempt.id, {
      nextState: "timed_out",
      terminalReason: "queue_expired",
      timeoutKind: "queue_expired",
      error: {
        code: "dispatcher_queue_expired",
        waitingLimitMs:
          dispatcher.timeoutPolicy?.waitingLimitMs ??
          dispatcher.timeoutPolicy?.queueTtlMs,
      },
    });
    log.warn(
      "DISPATCHER",
      `${provider}/${model}: no lease within waiting_limit. Check active accounts, slots, collection membership.`,
    );
    return createErrorResult(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `${provider} dispatcher could not assign a connection for ${model} within the queue waiting limit.`,
    ).response;
  }

  const attemptId = lease.attemptId || lease.attempt?.id;
  if (!attemptId) {
    log.error(
      "DISPATCHER",
      `${provider}/${model}: lease missing attemptId after tryLeaseRequest`,
    );
    return createErrorResult(
      HTTP_STATUS.INTERNAL_ERROR || 500,
      `${provider} dispatcher lease missing attempt id`,
    ).response;
  }

  log.info(
    "DISPATCHER",
    `${provider}/${model}: LEASE_OK attempt=${attemptId.slice(0, 8)}… conn=${String(lease.connectionId || "").slice(0, 8)}… state=${lease.attempt?.state || "?"}`,
  );

  // Idempotent if lease SQL already set connecting.
  await dispatcher.markAttemptConnecting(attemptId, {
    pathMode: lease.pathMode || null,
  });

  log.info(
    "DISPATCHER",
    `${provider}/${model}: CONNECT_OK attempt=${attemptId.slice(0, 8)}… loading connection`,
  );

  const rawConnection = await getProviderConnectionById(lease.connectionId);
  if (!rawConnection || rawConnection.isActive !== true) {
    await dispatcher.failAttempt(attemptId, {
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
  log.info(
    "DISPATCHER",
    `${provider}/${model}: credentials loaded, refreshing token if needed`,
  );
  credentials = await checkAndRefreshToken(provider, credentials);
  if (credentials?.refreshUnrecoverable) {
    await dispatcher.failAttempt(attemptId, {
      nextState: "failed",
      terminalReason: "auth_refresh_unrecoverable",
      error: {
        connectionId: lease.connectionId,
        code: credentials.refreshErrorCode || "unrecoverable_refresh_error",
      },
    });
    log.warn(
      "DISPATCHER",
      `${provider}/${model}: abort after unrecoverable token refresh (no upstream)`,
    );
    return createErrorResult(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `Managed ${provider} connection requires re-authentication`,
    ).response;
  }
  log.info(
    "DISPATCHER",
    `${provider}/${model}: token ready, entering handleChatCore`,
  );

  let finalized = false;
  const finalizeSuccess = async (terminalReason = "success") => {
    if (finalized) return;
    finalized = true;
    await dispatcher.completeAttempt(attemptId, { terminalReason });
  };
  const finalizeFailure = async (terminalReason, errorPayload = {}) => {
    if (finalized) return;
    finalized = true;
    await dispatcher.failAttempt(attemptId, {
      nextState: "failed",
      terminalReason,
      error: errorPayload,
    });
  };

  let persistedContinuationKey = null;
  const dispatcherHooks = {
    onConnectStarted: async ({ pathMode = null } = {}) => {
      await dispatcher.markAttemptConnecting(attemptId, { pathMode });
    },
    onStreamStarted: async () => {
      await dispatcher.markAttemptStreamStarted(attemptId);
    },
    onFirstProgress: async () => {
      await dispatcher.markAttemptProgress(attemptId);
    },
    onProgress: async () => {
      await dispatcher.markAttemptProgress(attemptId);
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
    // Streaming non-SSE / pipe failures — release the slot even if the outer
    // result path is slow or missed.
    onFailed: async ({ status = null, error = null } = {}) => {
      await finalizeFailure("upstream_error", {
        status,
        message:
          typeof error === "string"
            ? error
            : error?.message || error?.code || "upstream_failed",
      });
    },
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
      result.error || `${provider} upstream error`,
    ).response
  );
}
