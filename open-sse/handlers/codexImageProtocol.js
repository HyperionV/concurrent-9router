import { randomUUID } from "node:crypto";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_USER_AGENT = "codex-imagen/0.2.6";
const CODEX_VERSION = "0.129.0";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_MODEL_SUFFIX = "-image";
const CODEX_REF_DETAIL = "high";
const NO_IMAGE_MESSAGE =
  "Codex did not return an image. Account may not be entitled (Plus/Pro required).";

function decodeCodexAccountId(idToken) {
  try {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (b64.length % 4)) % 4;
    const payload = JSON.parse(
      Buffer.from(b64 + "=".repeat(pad), "base64").toString("utf8"),
    );
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

function stripCodexImageModel(model) {
  return model.endsWith(CODEX_MODEL_SUFFIX)
    ? model.slice(0, -CODEX_MODEL_SUFFIX.length)
    : model;
}

function toCodexDataUrl(input) {
  if (!input || typeof input !== "string") return null;
  if (/^data:image\//i.test(input) || /^https?:\/\//i.test(input)) return input;
  return `data:image/png;base64,${input}`;
}

function buildCodexContent(prompt, refs, detail = CODEX_REF_DETAIL) {
  const content = [];
  refs.forEach((url, index) => {
    content.push({
      type: "input_text",
      text: `<image name=image${index + 1}>`,
    });
    content.push({ type: "input_image", image_url: url, detail });
    content.push({ type: "input_text", text: "</image>" });
  });
  content.push({ type: "input_text", text: prompt });
  return content;
}

export function buildCodexImageHeaders(credentials) {
  const accountId =
    credentials?.providerSpecificData?.chatgptAccountId ||
    decodeCodexAccountId(credentials?.idToken);

  return {
    accept: "text/event-stream, application/json",
    authorization: `Bearer ${credentials?.accessToken || ""}`,
    "chatgpt-account-id": accountId || "",
    "content-type": "application/json",
    originator: CODEX_ORIGINATOR,
    session_id: randomUUID(),
    "user-agent": CODEX_USER_AGENT,
    version: CODEX_VERSION,
    "x-client-request-id": randomUUID(),
  };
}

export function buildCodexImageRequest(model, body) {
  const { prompt, image, images } = body;
  const refs = [];
  if (Array.isArray(images)) {
    images.forEach((item) => {
      const url = toCodexDataUrl(item);
      if (url) refs.push(url);
    });
  }

  const single = toCodexDataUrl(image);
  if (single) refs.push(single);
  const detail = body.image_detail || CODEX_REF_DETAIL;
  const imageTool = {
    type: "image_generation",
    output_format: (body.output_format || "png").toLowerCase(),
  };

  if (body.size && body.size !== "") imageTool.size = body.size;
  if (body.quality && body.quality !== "") imageTool.quality = body.quality;
  if (body.background && body.background !== "") {
    imageTool.background = body.background;
  }
  if (body.mask && body.mask !== "") {
    imageTool.input_image_mask = {
      image_url: toCodexDataUrl(body.mask),
    };
  }

  return {
    model: stripCodexImageModel(model),
    instructions: "",
    input: [
      {
        type: "message",
        role: "user",
        content: buildCodexContent(prompt, refs, detail),
      },
    ],
    tools: [imageTool],
    tool_choice: "auto",
    parallel_tool_calls: false,
    prompt_cache_key: randomUUID(),
    stream: true,
    store: false,
    reasoning: null,
  };
}

export async function parseCodexImageStream(response, log, callbacks = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let imageB64 = null;
  let lastEvent = null;
  let bytesReceived = 0;
  let lastProgressLogMs = 0;

  const processBlock = async (block) => {
    const lines = block.split("\n");
    let eventName = null;
    let dataStr = "";
    for (const line of lines) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
    }
    if (!eventName) return;

    if (eventName !== lastEvent) {
      log?.info?.("IMAGE", `codex progress: ${eventName}`);
      lastEvent = eventName;
    }

    const now = Date.now();
    if (callbacks.onProgress && now - lastProgressLogMs > 200) {
      lastProgressLogMs = now;
      await callbacks.onProgress({ stage: eventName, bytesReceived });
    }

    if (
      eventName === "response.image_generation_call.partial_image" &&
      dataStr
    ) {
      try {
        const data = JSON.parse(dataStr);
        if (callbacks.onPartialImage && data?.partial_image_b64) {
          await callbacks.onPartialImage({
            b64_json: data.partial_image_b64,
            index: data.partial_image_index,
          });
        }
      } catch {}
    }

    if (eventName === "response.output_item.done" && dataStr) {
      try {
        const data = JSON.parse(dataStr);
        const item = data?.item;
        if (item?.type === "image_generation_call" && item.result) {
          imageB64 = item.result;
        }
      } catch {}
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesReceived += value?.byteLength || 0;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      await processBlock(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) await processBlock(buffer);

  return imageB64;
}

export function buildCodexSseResponse(
  providerResponse,
  log,
  { onSuccess, onFailure, onProgress, upstreamController } = {},
) {
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (event, data) => {
        controller.enqueue(
          enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      try {
        const b64 = await parseCodexImageStream(providerResponse, log, {
          onProgress: async (info) => {
            if (onProgress) await onProgress(info);
            send("progress", info);
          },
          onPartialImage: async (info) => {
            if (onProgress) await onProgress({ stage: "partial_image" });
            send("partial_image", info);
          },
        });

        if (!b64) {
          if (onFailure) {
            await onFailure({
              status: HTTP_STATUS.BAD_GATEWAY,
              error: NO_IMAGE_MESSAGE,
              terminalReason: "no_image",
            });
          }
          send("error", { message: NO_IMAGE_MESSAGE });
        } else {
          if (onSuccess) await onSuccess();
          send("done", {
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: b64 }],
          });
        }
      } catch (err) {
        if (onFailure) {
          await onFailure({
            status: HTTP_STATUS.BAD_GATEWAY,
            error: err?.message || "Stream failed",
            terminalReason:
              err?.name === "AbortError" ? "client_disconnect" : "stream_error",
          });
        }
        send("error", { message: err?.message || "Stream failed" });
      } finally {
        controller.close();
      }
    },
    cancel() {
      upstreamController?.abort?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function normalizeCodexImageResponse(responseBody, prompt) {
  if (responseBody.created && Array.isArray(responseBody.data)) {
    return responseBody;
  }

  return {
    created: Math.floor(Date.now() / 1000),
    data: responseBody?.data?.length
      ? responseBody.data
      : [{ b64_json: "", revised_prompt: prompt }],
  };
}

export function buildCodexBinaryResponse(normalized, body) {
  const first = normalized.data?.[0];
  const b64 = first?.b64_json;
  if (!b64) return null;

  const fmt = (body.output_format || "png").toLowerCase();
  const mime =
    fmt === "jpeg" || fmt === "jpg"
      ? "image/jpeg"
      : fmt === "webp"
        ? "image/webp"
        : "image/png";
  const extension = fmt === "jpeg" ? "jpg" : fmt;

  return new Response(Buffer.from(b64, "base64"), {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": `inline; filename="image.${extension}"`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export function getCodexNoImageMessage() {
  return NO_IMAGE_MESSAGE;
}

export function getCodexResponsesUrl() {
  return CODEX_RESPONSES_URL;
}
