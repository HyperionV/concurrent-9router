import { getProviderConnectionById, getSettings } from "@/lib/localDb.js";
import { buildManagedCredentials } from "@/lib/dispatcher/connectionState.js";
import { getCodexDispatcher } from "@/lib/dispatcher/index.js";
import {
  persistConversationAffinity,
  resolveConversationKey,
} from "@/lib/dispatcher/conversationAffinity.js";
import {
  checkAndRefreshToken,
  updateProviderCredentials,
} from "@/sse/services/tokenRefresh.js";
import {
  clearAccountError,
  markAccountUnavailable,
} from "@/sse/services/auth.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "@/sse/utils/logger.js";
import { createErrorResult } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

function shouldManageCodexRequest(settings, provider) {
  if (!settings.dispatcherEnabled) return false;
  if (settings.dispatcherCodexOnly !== false && provider !== "codex")
    return false;
  return provider === "codex";
}

export async function maybeHandleManagedCodexRequest({
  body,
  provider,
  model,
  modelStr,
  request,
  clientRawRequest,
  apiKey,
  providerThinking,
  ccFilterNaming,
}) {
  const settings = await getSettings();
  if (!shouldManageCodexRequest(settings, provider)) {
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
        },
      });

  if (!queued) {
    return createErrorResult(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Codex dispatcher could not queue request",
    ).response;
  }

  const lease = await dispatcher.tryLeaseRequest(queued.request.id);
  if (!lease) {
    await dispatcher.failAttempt(queued.attempt.id, {
      nextState: "failed",
      terminalReason: "no_capacity",
      error: { code: "dispatcher_no_capacity" },
    });
    return createErrorResult(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      "Codex dispatcher has no eligible capacity",
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

  if (provider === "codex" && !credentials.projectId) {
    const pid = await getProjectIdForConnection(
      credentials.connectionId,
      credentials.accessToken,
    );
    if (pid) {
      credentials.projectId = pid;
      updateProviderCredentials(credentials.connectionId, {
        projectId: pid,
      }).catch(() => {});
    }
  }

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
