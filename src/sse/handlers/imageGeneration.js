import {
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
  resolveActiveApiKeyRecord,
} from "../services/auth.js";
import { getCodexImageDispatcher } from "@/lib/dispatcher/imageIndex.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo } from "../services/model.js";
import { handleImageGenerationCore } from "open-sse/handlers/imageGenerationCore.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import {
  updateProviderCredentials,
  checkAndRefreshToken,
} from "../services/tokenRefresh.js";
import { DISPATCH_ATTEMPT_STATE } from "@/lib/dispatcher/types.js";
import * as log from "../utils/logger.js";

const IMAGE_QUEUE_POLL_MS = 250;
const IMAGE_QUEUE_TIMEOUT_MS = 10 * 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildCredentialsFromConnection(connection) {
  const rawConnection = connection?._connection || connection;
  return {
    apiKey: connection.apiKey,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    projectId: connection.projectId,
    connectionName:
      connection.displayName ||
      connection.name ||
      connection.email ||
      connection.id,
    copilotToken: connection.providerSpecificData?.copilotToken,
    providerSpecificData: {
      ...(connection.providerSpecificData || {}),
    },
    connectionId: connection.id,
    testStatus: connection.testStatus,
    lastError: connection.lastError,
    _connection: rawConnection,
  };
}

function shouldMarkUnavailableForImageFailure(status, terminalReason) {
  if (
    terminalReason === "client_disconnect" ||
    terminalReason === "cancelled"
  ) {
    return false;
  }
  return Number(status) >= 400;
}

export async function handleImageGeneration(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const url = new URL(request.url);
  const preferredConnectionId = request.headers.get("x-connection-id") || null;
  const wantsStream = (request.headers.get("accept") || "").includes(
    "text/event-stream",
  );
  const binaryOutput = url.searchParams.get("response_format") === "binary";
  const modelStr = body.model;

  log.request(
    "POST",
    `${url.pathname} | ${modelStr || "missing-model"} | imageFormat=${
      binaryOutput ? "binary" : "json"
    }`,
  );

  const apiKey = extractApiKey(request);
  const settings = await getSettings();
  const activeApiKeyRecord = apiKey
    ? await resolveActiveApiKeyRecord(apiKey)
    : null;

  if (apiKey && !activeApiKeyRecord) {
    log.warn("AUTH", "Invalid or inactive API key supplied for image request");
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
  }

  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn(
        "AUTH",
        "Missing API key for image request (requireApiKey=true)",
      );
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = activeApiKeyRecord || (await isValidApiKey(apiKey));
    if (!valid) {
      log.warn(
        "AUTH",
        "Invalid API key for image request (requireApiKey=true)",
      );
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  if (!body.prompt) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      "Missing required field: prompt",
    );
  }

  const modelInfo = await getModelInfo(modelStr);
  if (!modelInfo.provider) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;
  if (provider !== "codex") {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support image generation`,
    );
  }

  const { dispatcher, getConnections } = getCodexImageDispatcher();
  const queued = await dispatcher.enqueueRequest({
    provider,
    modelId: model,
    metadata: {
      preferredConnectionId,
      apiKeyId: activeApiKeyRecord?.id || null,
      streamToClient: wantsStream && !binaryOutput,
      binaryOutput,
    },
  });

  const queueStartedAt = Date.now();
  let lease = null;
  while (!lease) {
    lease = await dispatcher.tryLeaseRequest(queued.request.id);
    if (lease) break;

    const activeConnections = await getConnections();
    if (activeConnections.length === 0) {
      await dispatcher.failAttempt(queued.attempt.id, {
        terminalReason: "no_active_connection",
        error: { message: `No credentials for provider: ${provider}` },
      });
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `No credentials for provider: ${provider}`,
      );
    }

    if (request.signal?.aborted) {
      await dispatcher.failAttempt(queued.attempt.id, {
        nextState: DISPATCH_ATTEMPT_STATE.CANCELLED,
        terminalReason: "client_disconnect",
      });
      return errorResponse(499, "Client disconnected");
    }

    if (Date.now() - queueStartedAt >= IMAGE_QUEUE_TIMEOUT_MS) {
      await dispatcher.failAttempt(queued.attempt.id, {
        nextState: DISPATCH_ATTEMPT_STATE.TIMED_OUT,
        terminalReason: "queue_expired",
        error: { message: "Image dispatcher queue expired" },
      });
      return unavailableResponse(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        `[${provider}/${model}] Image dispatcher queue expired`,
      );
    }

    await sleep(IMAGE_QUEUE_POLL_MS);
  }

  const credentials = buildCredentialsFromConnection(lease.connection);
  const refreshedCredentials = await checkAndRefreshToken(
    provider,
    credentials,
  );

  let finalized = false;
  const finalizeFailure = async ({
    status = HTTP_STATUS.BAD_GATEWAY,
    error = "Image request failed",
    terminalReason = "error",
  } = {}) => {
    if (finalized) return;
    finalized = true;
    await dispatcher.failAttempt(lease.attemptId, {
      terminalReason,
      error: { status, message: error },
    });
    if (shouldMarkUnavailableForImageFailure(status, terminalReason)) {
      await markAccountUnavailable(
        credentials.connectionId,
        status,
        error,
        provider,
        model,
      );
    }
  };

  const result = await handleImageGenerationCore({
    body,
    modelInfo: { provider, model },
    credentials: refreshedCredentials,
    streamToClient: wantsStream && !binaryOutput,
    binaryOutput,
    abortSignal: request.signal,
    dispatcherHooks: {
      onConnectStart: () => dispatcher.markAttemptConnecting(lease.attemptId),
      onStreamStart: () => dispatcher.markAttemptStreamStarted(lease.attemptId),
      onProgress: () => dispatcher.markAttemptProgress(lease.attemptId),
      onSuccess: async () => {
        if (finalized) return;
        finalized = true;
        await dispatcher.completeAttempt(lease.attemptId);
      },
      onFailure: finalizeFailure,
    },
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
    log,
  });

  if (result.success) return result.response;

  await finalizeFailure({
    status: result.status,
    error: result.error,
    terminalReason: "provider_error",
  });
  return result.response;
}
