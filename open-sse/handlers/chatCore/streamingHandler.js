import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import {
  createSSETransformStreamWithLogger,
  createPassthroughStreamWithLogger,
} from "../../utils/stream.js";
import { pipeWithDisconnect } from "../../utils/streamHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { STREAM_STALL_TIMEOUT_MS } from "../../config/runtimeConfig.js";
import { buildAbortedResponsesTerminalBytes } from "../../utils/responsesStreamHelpers.js";
import {
  buildRequestDetail,
  extractRequestConfig,
  saveUsageStats,
} from "./requestDetail.js";
import { saveRequestDetail } from "@/lib/usageDb.js";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Access-Control-Allow-Origin": "*",
};

// Responses-API providers emit Responses SSE → translate into client format
const RESPONSES_SOURCE_TO_TARGET = {
  [FORMATS.OPENAI_RESPONSES]: FORMATS.OPENAI_RESPONSES,
  [FORMATS.CLAUDE]: FORMATS.CLAUDE,
  [FORMATS.ANTIGRAVITY]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI]: FORMATS.ANTIGRAVITY,
  [FORMATS.GEMINI_CLI]: FORMATS.ANTIGRAVITY,
};

/**
 * Determine which SSE transform stream to use based on provider/format.
 */
function buildTransformStream({
  provider,
  sourceFormat,
  targetFormat,
  userAgent,
  reqLogger,
  toolNameMap,
  model,
  connectionId,
  body,
  onStreamComplete,
  apiKey,
  onFirstProgress,
  onResponseIdentity,
}) {
  const isDroidCLI =
    userAgent?.toLowerCase().includes("droid") ||
    userAgent?.toLowerCase().includes("codex-cli");
  const isResponsesProvider =
    PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES ||
    provider === "codex" ||
    provider === "grok-cli";
  const needsResponsesTranslation =
    isResponsesProvider &&
    targetFormat === FORMATS.OPENAI_RESPONSES &&
    !isDroidCLI;

  if (needsResponsesTranslation) {
    const responsesTarget =
      RESPONSES_SOURCE_TO_TARGET[sourceFormat] || FORMATS.OPENAI;
    return createSSETransformStreamWithLogger(
      FORMATS.OPENAI_RESPONSES,
      responsesTarget,
      provider,
      reqLogger,
      toolNameMap,
      model,
      connectionId,
      body,
      onStreamComplete,
      apiKey,
      onFirstProgress,
      onResponseIdentity,
    );
  }

  if (needsTranslation(targetFormat, sourceFormat)) {
    return createSSETransformStreamWithLogger(
      targetFormat,
      sourceFormat,
      provider,
      reqLogger,
      toolNameMap,
      model,
      connectionId,
      body,
      onStreamComplete,
      apiKey,
      onFirstProgress,
      onResponseIdentity,
    );
  }

  return createPassthroughStreamWithLogger(
    provider,
    reqLogger,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    onFirstProgress,
    onResponseIdentity,
  );
}

/**
 * Handle streaming response — pipe provider SSE through transform stream to client.
 */
export async function handleStreamingResponse({
  providerResponse,
  provider,
  model,
  sourceFormat,
  targetFormat,
  userAgent,
  body,
  stream,
  translatedBody,
  finalBody,
  requestStartTime,
  connectionId,
  apiKey,
  clientRawRequest,
  onRequestSuccess,
  routingDecision = null,
  reqLogger,
  toolNameMap,
  streamController,
  onStreamComplete,
  dispatcherHooks = null,
  streamDetailId = null,
}) {
  if (dispatcherHooks?.onStreamStarted) {
    dispatcherHooks.onStreamStarted().catch(() => {});
  }

  // When upstream returns HTML/text instead of SSE (e.g. Cloudflare 5xx page),
  // piping through the SSE transform crashes the router. Return clean JSON.
  const upstreamContentType = (
    providerResponse.headers.get("content-type") || ""
  ).toLowerCase();
  if (
    upstreamContentType &&
    !upstreamContentType.includes("text/event-stream") &&
    !upstreamContentType.includes("application/json")
  ) {
    const bodyText = await providerResponse.text().catch(() => "");
    const titleMatch = bodyText.match(/<title>([^<]+)<\/title>/i);
    const sanitizedTitle = (titleMatch?.[1] || "")
      .replace(/<[^>]*>/g, "")
      .replace(/[\r\n]+/g, " ")
      .trim()
      .slice(0, 160);
    const shortMsg =
      sanitizedTitle ||
      (bodyText.length < 200
        ? bodyText.replace(/<[^>]*>/g, "").trim().slice(0, 160)
        : `Upstream returned non-SSE response (${upstreamContentType})`);
    const status = providerResponse.status || 502;
    console.warn(
      `[STREAM] ${provider} | ${model} | blocked pipe: ${shortMsg} [${status}]`,
    );
    streamController?.handleError?.(new Error(`upstream non-SSE: ${status}`));
    if (dispatcherHooks?.onFailed) {
      dispatcherHooks
        .onFailed({
          status,
          error: { message: shortMsg, code: "upstream_non_sse" },
        })
        .catch(() => {});
    }
    return {
      success: false,
      response: new Response(
        JSON.stringify({
          error: { message: `[${status}]: ${shortMsg}` },
        }),
        {
          status,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      ),
    };
  }

  // Keep dispatcher lastProgressAt fresh while the stream is alive.
  // Codex Responses often never hits chat-style content detectors, so relying
  // only on onFirstProgress left lastProgress frozen → idle_timeout at 35s.
  const PROGRESS_THROTTLE_MS = 5_000;
  let successMarked = false;
  let lastProgressEmitMs = 0;

  const touchDispatcherProgress = async () => {
    const now = Date.now();
    if (!successMarked) {
      successMarked = true;
      lastProgressEmitMs = now;
      if (dispatcherHooks?.onFirstProgress) {
        await dispatcherHooks.onFirstProgress();
      } else if (dispatcherHooks?.onProgress) {
        await dispatcherHooks.onProgress();
      }
      if (onRequestSuccess) {
        await onRequestSuccess();
      }
      return;
    }
    if (!dispatcherHooks?.onProgress) return;
    if (now - lastProgressEmitMs < PROGRESS_THROTTLE_MS) return;
    lastProgressEmitMs = now;
    await dispatcherHooks.onProgress();
  };

  const onFirstProgress = async () => {
    await touchDispatcherProgress();
  };

  const onUpstreamActivity = () => {
    // Fire-and-forget: never block the upstream pipe on SQLite progress writes.
    touchDispatcherProgress().catch(() => {});
  };

  const wrappedStreamComplete = async (contentObj, usage, ttftAt) => {
    if (!successMarked) {
      await onFirstProgress();
    }
    onStreamComplete?.(contentObj, usage, ttftAt);
    if (dispatcherHooks?.onCompleted) {
      await dispatcherHooks.onCompleted();
    }
  };

  const transformStream = buildTransformStream({
    provider,
    sourceFormat,
    targetFormat,
    userAgent,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete: wrappedStreamComplete,
    apiKey,
    onFirstProgress,
    onResponseIdentity: dispatcherHooks?.onResponseIdentity,
  });

  // Responses passthrough: synthesize response.failed + [DONE] on abort/stall
  const isResponsesPassthrough =
    sourceFormat === FORMATS.OPENAI_RESPONSES &&
    targetFormat === FORMATS.OPENAI_RESPONSES;
  const onAbortTerminal = isResponsesPassthrough
    ? buildAbortedResponsesTerminalBytes
    : null;
  const stallTimeoutMs =
    PROVIDERS[provider]?.stallTimeoutMs || STREAM_STALL_TIMEOUT_MS;

  const transformedBody = pipeWithDisconnect(
    providerResponse,
    transformStream,
    streamController,
    onAbortTerminal,
    stallTimeoutMs,
    onUpstreamActivity,
  );

  // Prefer stable detail id from buildOnStreamComplete when provided (OPT-008)
  const detailId =
    streamDetailId ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  saveRequestDetail(
    buildRequestDetail(
      {
        provider,
        model,
        connectionId,
        latency: { ttft: 0, total: Date.now() - requestStartTime },
        tokens: { prompt_tokens: 0, completion_tokens: 0 },
        request: extractRequestConfig(body, stream),
        routing: routingDecision,
        providerRequest: finalBody || translatedBody || null,
        providerResponse: "[Streaming - raw response not captured]",
        response: {
          content: "[Streaming in progress...]",
          thinking: null,
          type: "streaming",
        },
        status: "success",
      },
      { id: detailId },
    ),
  ).catch((err) => {
    console.error(
      "[RequestDetail] Failed to save streaming request:",
      err.message,
    );
  });

  return {
    success: true,
    response: new Response(transformedBody, { headers: SSE_HEADERS }),
  };
}

/**
 * Build onStreamComplete callback for streaming usage tracking.
 */
export function buildOnStreamComplete({
  provider,
  model,
  connectionId,
  apiKey,
  requestStartTime,
  body,
  stream,
  finalBody,
  translatedBody,
  clientRawRequest,
  routingDecision = null,
  streamDetailId = null,
}) {
  const detailId =
    streamDetailId ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

  const onStreamComplete = (contentObj, usage, ttftAt) => {
    const latency = {
      ttft: ttftAt ? ttftAt - requestStartTime : Date.now() - requestStartTime,
      total: Date.now() - requestStartTime,
    };
    const safeContent = contentObj?.content || "[Empty streaming response]";
    const safeThinking = contentObj?.thinking || null;

    saveRequestDetail(
      buildRequestDetail(
        {
          provider,
          model,
          connectionId,
          latency,
          tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
          request: extractRequestConfig(body, stream),
          routing: routingDecision,
          providerRequest: finalBody || translatedBody || null,
          providerResponse: safeContent,
          response: {
            content: safeContent,
            thinking: safeThinking,
            type: "streaming",
          },
          status: "success",
        },
        { id: detailId },
      ),
    ).catch((err) => {
      console.error(
        "[RequestDetail] Failed to update streaming content:",
        err.message,
      );
    });

    saveUsageStats({
      provider,
      model,
      tokens: usage,
      connectionId,
      apiKey,
      endpoint: clientRawRequest?.endpoint,
      label: "STREAM USAGE",
    });
  };

  return { onStreamComplete, streamDetailId: detailId };
}
