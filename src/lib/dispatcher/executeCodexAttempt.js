import { getProviderConnectionById } from "@/lib/localDb.js";
import { buildManagedCredentials } from "@/lib/dispatcher/connectionState.js";
import { getCodexDispatcher } from "@/lib/dispatcher/index.js";
import {
  getConversationAffinity,
  persistConversationAffinity,
  resolveConversationKey,
} from "@/lib/dispatcher/conversationAffinity.js";
import { computeCodexAdmissionDecisionFromSettings } from "@/lib/dispatcher/admissionPolicy.js";
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

const LEASE_POLL_INTERVAL_MS = 100;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLease(dispatcher, requestId, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);

  while (Date.now() <= deadline) {
    const lease = await dispatcher.tryLeaseRequest(requestId);
    if (lease) {
      return lease;
    }
    await sleep(LEASE_POLL_INTERVAL_MS);
  }

  return null;
}

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
  if (provider !== "codex") {
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
  });
  if (decision.effectiveBehavior !== "managed") {
    return null;
  }

  return executeManagedCodexRequest({
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

async function executeManagedCodexRequest({
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
  const { dispatcher } = getCodexDispatcher();
  const queued = requestId
    ? await dispatcher.requeueRequest(requestId, {
        metadataPatch: {
          routeModel: modelStr,
          retryBudget,
          admission: decision,
        },
      })
    : await dispatcher.enqueueRequest({
        provider: "codex",
        modelId: model,
        sourceEndpoint: clientRawRequest?.endpoint || null,
        sourceFormat: request?.url
          ? detectFormatByEndpoint(new URL(request.url).pathname, body)
          : null,
        targetFormat: "openai-responses",
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
      "Codex dispatcher could not queue request",
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
    return createErrorResult(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Codex dispatcher queue expired before a slot became available",
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
      "Managed Codex connection unavailable",
    ).response;
  }

  let credentials = await buildManagedCredentials(rawConnection);
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
        provider: "codex",
        modelId: model,
        connectionId: lease.connectionId,
        sessionId:
          credentials?.providerSpecificData?.dispatchSessionId ||
          lease.connectionId,
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
    if (
      result.response?.headers
        ?.get?.("Content-Type")
        ?.includes("application/json")
    ) {
      await finalizeSuccess("success");
    }
    return result.response;
  }

  const { shouldFallback } = await markAccountUnavailable(
    credentials.connectionId,
    result.status,
    result.error,
    provider,
    model,
  );

  if (shouldFallback) {
    await finalizeFailure("fallback_requested", {
      status: result.status,
      message: result.error,
    });

    if (retryBudget > 0) {
      return executeManagedCodexRequest({
        body,
        provider,
        model,
        modelStr,
        request,
        clientRawRequest,
        apiKey,
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

  return result.response;
}
