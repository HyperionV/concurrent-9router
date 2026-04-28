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
const IMAGE_EDIT_FILE_FIELDS = ["image", "image[]"];

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

async function fileToDataUrl(file) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const mimeType = file.type || "image/png";
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

async function parseImageEditBody(request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return {
      error: errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid multipart body"),
    };
  }

  const images = [];
  for (const fieldName of IMAGE_EDIT_FILE_FIELDS) {
    for (const value of form.getAll(fieldName)) {
      if (value instanceof File && value.size > 0) {
        images.push(await fileToDataUrl(value));
      }
    }
  }

  if (form.get("mask")) {
    return {
      error: errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        "Codex image edits do not support mask uploads yet",
      ),
    };
  }

  return {
    body: {
      model: String(form.get("model") || ""),
      prompt: String(form.get("prompt") || ""),
      images,
      size: String(form.get("size") || ""),
      quality: String(form.get("quality") || ""),
      background: String(form.get("background") || ""),
      output_format: String(form.get("output_format") || ""),
      image_detail: String(form.get("image_detail") || ""),
    },
  };
}

async function runCodexImageRequest({
  request,
  body,
  sourceEndpoint,
  requireImages = false,
}) {
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
  if (requireImages && !body.images?.length) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      "Missing required field: image",
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
    sourceEndpoint,
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

export async function handleImageGeneration(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  return runCodexImageRequest({
    request,
    body,
    sourceEndpoint: "/v1/images/generations",
  });
}

export async function handleImageEdit(request) {
  const parsed = await parseImageEditBody(request);
  if (parsed.error) return parsed.error;

  return runCodexImageRequest({
    request,
    body: parsed.body,
    sourceEndpoint: "/v1/images/edits",
    requireImages: true,
  });
}
