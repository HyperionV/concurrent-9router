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
import { listQueuedDispatchRequests } from "@/lib/sqlite/dispatcherStore.js";
import {
  MAX_QUEUED_PER_PROVIDER,
  PRIORITY_HEADER,
  priorityClassFromHeader,
  queueWaitLimitMs,
} from "@/lib/dispatcher/priorityQueue.js";

/**
 * origin/main lease wait — adaptive polling tryLeaseRequest.
 * First 4 iterations poll every 25ms to capture early freed slots (<25ms latency),
 * then back off to 100ms steady-state to avoid CPU waste during deeper queues.
 * Do not use evented waiters here; that path regressed concurrent Codex.
 */
const LEASE_POLL_INTERVAL_MS = 100;
const LEASE_POLL_INITIAL_MS = 25;
const LEASE_POLL_INITIAL_COUNT = 4;

const CLIENT_CLOSED_STATUS = 499;

function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Poll for a lease until granted, the deadline passes, or the client
 * disconnects (`signal` aborts). Returns the lease or null.
 */
export async function waitForLease(dispatcher, requestId, timeoutMs, signal = null) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let attempt = 0;
  while (Date.now() <= deadline && !signal?.aborted) {
    const lease = await dispatcher.tryLeaseRequest(requestId);
    if (lease) return lease;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const interval =
      attempt < LEASE_POLL_INITIAL_COUNT
        ? LEASE_POLL_INITIAL_MS
        : LEASE_POLL_INTERVAL_MS;
    attempt++;
    await sleepUnlessAborted(Math.min(interval, remaining), signal);
  }
  return null;
}

function clientClosedResponse(provider) {
  return createErrorResult(
    CLIENT_CLOSED_STATUS,
    `${provider} request cancelled: client disconnected`,
  ).response;
}

function resolveTargetFormat(provider) {
  return PROVIDERS[provider]?.format || "openai";
}

export function detectIsContinuation(body) {
  if (!body || typeof body !== "object") return false;
  if (body.previous_response_id || body.previousResponseId) return true;
  if (Array.isArray(body.messages)) {
    if (body.messages.length > 2) return true;
    if (body.messages.some((m) => m?.role === "tool" || m?.role === "assistant")) return true;
  }
  if (Array.isArray(body.input) && body.input.length > 1) {
    return true;
  }
  return false;
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
    provider,
  );
  const decision = computeCodexAdmissionDecisionFromSettings({
    settings,
    apiKeyRecord,
    hasManagedAffinity:
      affinity?.state === "active" &&
      (!affinity?.provider || affinity?.provider === provider),
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
  excludedConnectionIds = [],
}) {
  const clientSignal = request?.signal || null;
  const conversationKey = resolveConversationKey({
    body,
    clientRawRequest,
  });
  const affinity = getConversationAffinity(
    conversationKey,
    apiKeyRecord?.id || null,
    provider,
  );
  const dispatcherEntry = getProviderDispatcher(provider);
  const { dispatcher } = dispatcherEntry;
  const targetFormat = resolveTargetFormat(provider);

  // Safety valve only: normal overload waits in the queue instead.
  if (
    !requestId &&
    listQueuedDispatchRequests(provider, MAX_QUEUED_PER_PROVIDER).length >=
      MAX_QUEUED_PER_PROVIDER
  ) {
    const response = createErrorResult(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `${provider} queue is full; retry shortly`,
    ).response;
    response.headers.set("Retry-After", "30");
    return response;
  }

  const queued = requestId
    ? await dispatcher.requeueRequest(requestId, {
        metadataPatch: {
          routeModel: modelStr,
          admission: decision,
          excludedConnectionIds,
          isContinuation: true,
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
          admission: decision,
          excludedConnectionIds,
          isContinuation: detectIsContinuation(body),
          priorityClass: priorityClassFromHeader(
            request?.headers?.get?.(PRIORITY_HEADER),
          ),
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
  // The waiting limit depends on the class and counts from the first enqueue,
  // so a failover retry does not get a fresh wait.
  const waitingLimitMs = queueWaitLimitMs(queued.request);
  const waitedMs = Date.now() - new Date(queued.request.queuedAt || Date.now()).getTime();
  const lease = await waitForLease(
    dispatcher,
    queued.request.id,
    Math.max(0, waitingLimitMs - waitedMs),
    clientSignal,
  );
  if (!lease && clientSignal?.aborted) {
    await dispatcher.failAttempt(queued.attempt.id, {
      nextState: "cancelled",
      terminalReason: "client_disconnected",
    });
    log.info(
      "DISPATCHER",
      `${provider}/${model}: client left while queued, cancelled request=${queued.request.id.slice(0, 8)}…`,
    );
    return clientClosedResponse(provider);
  }
  if (!lease) {
    await dispatcher.failAttempt(queued.attempt.id, {
      nextState: "timed_out",
      terminalReason: "queue_expired",
      timeoutKind: "queue_expired",
      error: {
        code: "dispatcher_queue_expired",
        waitingLimitMs,
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

  if (clientSignal?.aborted) {
    await dispatcher.failAttempt(attemptId, {
      nextState: "cancelled",
      terminalReason: "client_disconnected",
    });
    return clientClosedResponse(provider);
  }

  // Any throw between lease and finalisation must free the slot. failAttempt
  // only moves active attempts, so it is a no-op once the attempt finished.
  try {
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
      if (conversationKey && lease?.connectionId) {
        try {
          persistConversationAffinity({
            conversationKey,
            provider,
            modelId: model,
            connectionId: lease.connectionId,
            sessionId: credentials?.providerSpecificData?.dispatchSessionId || null,
            apiKeyId: apiKeyRecord?.id || null,
          });
        } catch (err) {
          log.warn("DISPATCHER", `failed to persist conversation affinity: ${err.message}`);
        }
      }
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
      clientSignal,
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
        if (finalized) return;
        finalized = true;
        await dispatcher.failAttempt(attemptId, {
          nextState: "cancelled",
          terminalReason: "client_disconnected",
        });
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

    // The client left mid-request: the account did nothing wrong, so no
    // cooldown and no failover — just free the slot.
    if (clientSignal?.aborted || result.status === CLIENT_CLOSED_STATUS) {
      if (!finalized) {
        finalized = true;
        await dispatcher.failAttempt(attemptId, {
          nextState: "cancelled",
          terminalReason: "client_disconnected",
        });
      }
      return clientClosedResponse(provider);
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

      // Carried in the call, not read back from the queued row: requeueRequest
      // returns the row as it was before the metadata patch.
      const updatedExcluded = Array.from(
        new Set([...excludedConnectionIds, credentials.connectionId]),
      );
      const connections = await dispatcherEntry.getConnections();
      const hasUntriedAccount = connections.some(
        (connection) => !updatedExcluded.includes(connection.id),
      );
      if (hasUntriedAccount) {
        log.warn(
          "DISPATCHER",
          `${provider}/${model}: retrying request=${queued.request.id.slice(0, 8)} on alternate account (excluded: ${updatedExcluded.map((id) => id.slice(0, 8)).join(",")})`,
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
          requestId: queued.request.id,
          excludedConnectionIds: updatedExcluded,
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
  } catch (error) {
    await dispatcher.failAttempt(attemptId, {
      nextState: "failed",
      terminalReason: "internal_error",
      error: { message: error?.message || String(error) },
    });
    throw error;
  }
}
