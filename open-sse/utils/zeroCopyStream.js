import { extractUsage } from "./usageTracking.js";
import { formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";

const sharedEncoder = new TextEncoder();
const sharedDecoder = new TextDecoder("utf-8", { fatal: false });

const DONE_BYTES = Buffer.from("[DONE]");
const USAGE_BYTES = Buffer.from('"usage"');
const RESPONSE_DONE_BYTES = Buffer.from("response.done");
const RESPONSE_FAILED_BYTES = Buffer.from("response.failed");

/**
 * High-performance zero-copy SSE passthrough TransformStream.
 * Directly forwards raw binary chunks (Uint8Array/Buffer) to downstream clients,
 * completely eliminating per-token string decoding, line splitting, and JSON re-serialization.
 */
export function createZeroCopyPassthroughStream(options = {}) {
  const {
    targetFormat = null,
    sourceFormat = null,
    provider = null,
    reqLogger = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    onFirstProgress = null,
    onResponseIdentity = null,
    apiKey = null,
  } = options;

  let ttftAt = null;
  let firstProgressSeen = false;
  let firstProgressPromise = null;
  let responseIdCaptured = false;
  let terminalSeen = false;
  let capturedUsage = null;
  let chunkCount = 0;
  let totalBytes = 0;

  function emitFirstProgressOnce() {
    if (firstProgressPromise) return firstProgressPromise;
    if (firstProgressSeen) return Promise.resolve();
    firstProgressSeen = true;
    firstProgressPromise = Promise.resolve(onFirstProgress?.()).finally(() => {
      firstProgressPromise = null;
    });
    return firstProgressPromise;
  }

  return new TransformStream({
    async transform(chunk, controller) {
      chunkCount++;
      totalBytes += chunk.byteLength || 0;
      if (!ttftAt) {
        ttftAt = Date.now();
      }

      // 1. Initial metadata inspection (first 3 chunks only)
      if (!responseIdCaptured && chunkCount <= 3) {
        try {
          const text = sharedDecoder.decode(chunk, { stream: true });
          const idMatch = text.match(/"id"\s*:\s*"([^"]+)"/);
          if (idMatch && idMatch[1]) {
            responseIdCaptured = true;
            try {
              onResponseIdentity?.(idMatch[1]);
            } catch {}
          }
        } catch {}
      }

      // 2. First progress notification (unblocks dispatcher attempt state)
      if (!firstProgressSeen) {
        await emitFirstProgressOnce();
      }

      // 3. Fast byte check for terminal markers & usage
      const buf = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(
            chunk.buffer,
            chunk.byteOffset || 0,
            chunk.byteLength || chunk.length || 0,
          );

      const hasDone = buf.includes(DONE_BYTES);
      const hasUsage = buf.includes(USAGE_BYTES);
      const hasRespDone = buf.includes(RESPONSE_DONE_BYTES);
      const hasRespFailed = buf.includes(RESPONSE_FAILED_BYTES);

      if (hasDone || hasRespDone || hasRespFailed) {
        terminalSeen = true;
      }

      if (hasUsage || hasRespDone || hasDone) {
        try {
          const text = sharedDecoder.decode(chunk, { stream: true });
          const lines = text.split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data:") && !trimmed.includes("[DONE]")) {
              const jsonStr = trimmed.slice(5).trim();
              if (jsonStr) {
                const parsed = JSON.parse(jsonStr);
                const extracted = extractUsage(parsed);
                if (extracted) {
                  capturedUsage = extracted;
                }
              }
            }
          }
        } catch {}
      }

      // Optional request logging
      if (reqLogger?.appendConvertedChunk) {
        try {
          const chunkText = sharedDecoder.decode(chunk, { stream: true });
          reqLogger.appendConvertedChunk(chunkText);
        } catch {}
      }

      // 4. Zero-copy forwarding: enqueue the chunk directly without modification
      controller.enqueue(chunk);
    },

    flush(controller) {
      // Incomplete Responses stream synthesis if upstream disconnected prematurely
      if (
        sourceFormat === "openai_responses" &&
        targetFormat === "openai_responses" &&
        !terminalSeen
      ) {
        const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
        controller.enqueue(sharedEncoder.encode(failedOutput));
        controller.enqueue(sharedEncoder.encode("data: [DONE]\n\n"));
      }

      try {
        onStreamComplete?.(
          { content: "", thinking: "", totalBytes },
          capturedUsage,
          ttftAt,
        );
      } catch (err) {
        console.warn("[ZeroCopyStream] onStreamComplete error:", err.message);
      }
    },
  });
}
