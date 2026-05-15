import {
  createErrorResult,
  parseUpstreamError,
  formatProviderError,
} from "../utils/error.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { refreshWithRetry } from "../services/tokenRefresh.js";
import { getExecutor } from "../executors/index.js";
import {
  buildCodexBinaryResponse,
  buildCodexImageHeaders,
  buildCodexImageRequest,
  buildCodexSseResponse,
  getCodexNoImageMessage,
  getCodexResponsesUrl,
  normalizeCodexImageResponse,
  parseCodexImageStream,
} from "./codexImageProtocol.js";

export async function handleImageGenerationCore({
  body,
  modelInfo,
  credentials,
  log,
  streamToClient = false,
  binaryOutput = false,
  onCredentialsRefreshed,
  onRequestSuccess,
  dispatcherHooks = null,
  abortSignal = null,
}) {
  const { provider, model } = modelInfo;

  if (!body.prompt) {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      "Missing required field: prompt",
    );
  }

  if (provider !== "codex") {
    return createErrorResult(
      HTTP_STATUS.BAD_REQUEST,
      `Provider '${provider}' does not support image generation`,
    );
  }

  const requestBody = buildCodexImageRequest(model, body);
  log?.debug?.(
    "IMAGE",
    `CODEX | ${model} | prompt="${body.prompt.slice(0, 50)}..."`,
  );

  const upstreamController = new AbortController();
  if (abortSignal) {
    if (abortSignal.aborted) upstreamController.abort();
    else {
      abortSignal.addEventListener("abort", () => upstreamController.abort(), {
        once: true,
      });
    }
  }

  let providerResponse;
  try {
    if (dispatcherHooks?.onConnectStart) await dispatcherHooks.onConnectStart();
    providerResponse = await fetch(getCodexResponsesUrl(), {
      method: "POST",
      headers: buildCodexImageHeaders(credentials),
      body: JSON.stringify(requestBody),
      signal: upstreamController.signal,
    });
  } catch (error) {
    const errMsg = formatProviderError(
      error,
      provider,
      model,
      HTTP_STATUS.BAD_GATEWAY,
    );
    log?.debug?.("IMAGE", `Fetch error: ${errMsg}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, errMsg);
  }

  const executor = getExecutor(provider);
  if (
    !executor?.noAuth &&
    (providerResponse.status === HTTP_STATUS.UNAUTHORIZED ||
      providerResponse.status === HTTP_STATUS.FORBIDDEN)
  ) {
    const newCredentials = await refreshWithRetry(
      () => executor.refreshCredentials(credentials, log),
      3,
      log,
    );

    if (newCredentials?.accessToken || newCredentials?.apiKey) {
      Object.assign(credentials, newCredentials);
      if (onCredentialsRefreshed) {
        await onCredentialsRefreshed(newCredentials);
      }

      try {
        providerResponse = await fetch(getCodexResponsesUrl(), {
          method: "POST",
          headers: buildCodexImageHeaders(credentials),
          body: JSON.stringify(requestBody),
          signal: upstreamController.signal,
        });
      } catch (retryError) {
        log?.warn?.(
          "TOKEN",
          `CODEX | retry after refresh failed: ${retryError?.message || retryError}`,
        );
      }
    }
  }

  if (!providerResponse.ok) {
    const { statusCode, message } = await parseUpstreamError(providerResponse);
    const errMsg = formatProviderError(
      new Error(message),
      provider,
      model,
      statusCode,
    );
    log?.debug?.("IMAGE", `Provider error: ${errMsg}`);
    if (dispatcherHooks?.onFailure) {
      await dispatcherHooks.onFailure({
        status: statusCode,
        error: errMsg,
        terminalReason: "provider_error",
      });
    }
    return createErrorResult(statusCode, errMsg);
  }

  let responseBody;
  try {
    if (streamToClient) {
      if (dispatcherHooks?.onStreamStart) await dispatcherHooks.onStreamStart();
      return {
        success: true,
        response: buildCodexSseResponse(providerResponse, log, {
          onSuccess: async () => {
            if (onRequestSuccess) await onRequestSuccess();
            if (dispatcherHooks?.onSuccess) await dispatcherHooks.onSuccess();
          },
          onFailure: dispatcherHooks?.onFailure,
          onProgress: dispatcherHooks?.onProgress,
          upstreamController,
        }),
      };
    }

    if (dispatcherHooks?.onStreamStart) await dispatcherHooks.onStreamStart();
    const b64 = await parseCodexImageStream(providerResponse, log, {
      onProgress: dispatcherHooks?.onProgress,
      onPartialImage: async () => {
        if (dispatcherHooks?.onProgress) {
          await dispatcherHooks.onProgress({ stage: "partial_image" });
        }
      },
    });
    if (!b64) {
      const noImageMessage = getCodexNoImageMessage();
      if (dispatcherHooks?.onFailure) {
        await dispatcherHooks.onFailure({
          status: HTTP_STATUS.BAD_GATEWAY,
          error: noImageMessage,
          terminalReason: "no_image",
        });
      }
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, noImageMessage);
    }

    responseBody = {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: b64 }],
    };
  } catch (error) {
    if (dispatcherHooks?.onFailure) {
      await dispatcherHooks.onFailure({
        status: HTTP_STATUS.BAD_GATEWAY,
        error: error?.message || "Invalid response from codex",
        terminalReason:
          error?.name === "AbortError" ? "client_disconnect" : "stream_error",
      });
    }
    return createErrorResult(
      HTTP_STATUS.BAD_GATEWAY,
      "Invalid response from codex",
    );
  }

  if (onRequestSuccess) {
    await onRequestSuccess();
  }
  if (dispatcherHooks?.onSuccess) {
    await dispatcherHooks.onSuccess();
  }

  const normalized = normalizeCodexImageResponse(responseBody, body.prompt);

  if (binaryOutput) {
    const binaryResponse = buildCodexBinaryResponse(normalized, body);
    if (binaryResponse) {
      return { success: true, response: binaryResponse };
    }
  }

  return {
    success: true,
    response: new Response(JSON.stringify(normalized), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    }),
  };
}
