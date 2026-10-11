import { extractUsage } from "./usageTracking.js";
import {
  formatIncompleteOpenAIResponsesStreamFailure,
  isOpenAIResponsesTerminalEvent,
  responsesTerminalOutcome,
} from "./responsesStreamHelpers.js";
import { createToolArgsDeltaRepair } from "./toolArgsDeltaRepair.js";
import { FORMATS } from "../translator/formats.js";

const sharedEncoder = new TextEncoder();
// SSE events end with a blank line; servers may use CRLF line endings.
const SSE_EVENT_SEPARATOR = /\r?\n\r?\n/;

/**
 * High-performance SSE passthrough TransformStream.
 * Forwards the upstream bytes to the client unchanged (Responses streams only
 * pass through the tool-argument repair). A side copy of the text is parsed
 * event by event, across network chunk boundaries, to find the response id,
 * the usage and how the reply ended.
 */
export function createZeroCopyPassthroughStream(options = {}) {
  const {
    targetFormat = null,
    sourceFormat = null,
    reqLogger = null,
    onStreamComplete = null,
    onFirstProgress = null,
    onResponseIdentity = null,
  } = options;

  const isResponsesPassthrough =
    sourceFormat === FORMATS.OPENAI_RESPONSES && targetFormat === FORMATS.OPENAI_RESPONSES;
  // One decoder per stream: a multi-byte character can straddle two chunks.
  const decoder = new TextDecoder("utf-8", { fatal: false });

  let ttftAt = null;
  let firstProgressSeen = false;
  let firstProgressPromise = null;
  let responseIdCaptured = false;
  let capturedUsage = null;
  // "completed", "incomplete" or "failed" once a terminal event arrives.
  let outcome = null;
  let pendingText = "";
  let totalBytes = 0;
  const toolArgsRepair = isResponsesPassthrough ? createToolArgsDeltaRepair() : null;

  function emitFirstProgressOnce() {
    if (firstProgressPromise) return firstProgressPromise;
    if (firstProgressSeen) return Promise.resolve();
    firstProgressSeen = true;
    firstProgressPromise = Promise.resolve(onFirstProgress?.()).finally(() => {
      firstProgressPromise = null;
    });
    return firstProgressPromise;
  }

  function inspectEvent(rawEvent) {
    let eventName = null;
    const dataLines = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join("\n");
    if (!data) return;
    if (data === "[DONE]") {
      outcome ??= "completed";
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (!responseIdCaptured) {
      const responseId = parsed?.response?.id || parsed?.id;
      if (typeof responseId === "string" && responseId) {
        responseIdCaptured = true;
        try {
          onResponseIdentity?.(responseId);
        } catch {}
      }
    }

    const extracted = extractUsage(parsed);
    if (extracted) capturedUsage = extracted;

    if (isResponsesPassthrough) {
      if (isOpenAIResponsesTerminalEvent(eventName, parsed)) {
        outcome = responsesTerminalOutcome(eventName, parsed);
      }
    } else if (parsed?.error) {
      // An OpenAI chat stream reports a failure as an error object.
      outcome = "failed";
    }
  }

  function inspectText(text) {
    pendingText += text;
    const events = pendingText.split(SSE_EVENT_SEPARATOR);
    pendingText = events.pop() || "";
    for (const event of events) inspectEvent(event);
  }

  return new TransformStream({
    async transform(chunk, controller) {
      totalBytes += chunk.byteLength || 0;
      if (!ttftAt) ttftAt = Date.now();

      // First progress notification (unblocks dispatcher attempt state)
      if (!firstProgressSeen) await emitFirstProgressOnce();

      const text = decoder.decode(chunk, { stream: true });
      inspectText(text);
      reqLogger?.appendConvertedChunk?.(text);

      // Forward the bytes untouched. Responses streams go through the
      // tool-argument repair, which forwards untouched bytes unless a block
      // holds a function-call-arguments event.
      if (!toolArgsRepair) {
        controller.enqueue(chunk);
        return;
      }
      for (const out of toolArgsRepair.push(chunk)) controller.enqueue(out);
    },

    flush(controller) {
      if (toolArgsRepair) {
        for (const out of toolArgsRepair.flush()) controller.enqueue(out);
      }

      // The last event may arrive without a trailing blank line.
      inspectText(decoder.decode());
      if (pendingText.trim()) inspectEvent(pendingText);

      // A Responses stream that closed without a terminal event never finished:
      // tell the client it failed.
      if (isResponsesPassthrough && !outcome) {
        const failedOutput = formatIncompleteOpenAIResponsesStreamFailure();
        controller.enqueue(sharedEncoder.encode(failedOutput));
        controller.enqueue(sharedEncoder.encode("data: [DONE]\n\n"));
        outcome = "failed";
      }

      try {
        onStreamComplete?.(
          { content: "", thinking: "", totalBytes },
          capturedUsage,
          ttftAt,
          // Other formats have no reliable end marker; keep the old default.
          outcome || "completed",
        );
      } catch (err) {
        console.warn("[ZeroCopyStream] onStreamComplete error:", err.message);
      }
    },
  });
}
