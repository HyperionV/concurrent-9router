// Helpers for OpenAI Responses API streaming termination + event framing
import { FORMATS } from "../translator/formats.js";
import { formatSSE } from "./streamHelpers.js";

// Responses API events that signal the stream has reached a terminal state
const OPENAI_RESPONSES_TERMINAL_EVENTS = new Set([
  "response.completed",
  "response.incomplete",
  "response.done",
  "response.failed",
  "error"
]);
const TERMINAL_STATUSES = new Set(["completed", "done", "incomplete", "failed"]);

export function getOpenAIResponsesEventName(eventName, chunk) {
  if (eventName) return eventName;
  if (chunk && typeof chunk.type === "string") return chunk.type;
  return null;
}

export function isOpenAIResponsesTerminalEvent(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  if (OPENAI_RESPONSES_TERMINAL_EVENTS.has(type)) return true;
  return TERMINAL_STATUSES.has(chunk?.response?.status);
}

/**
 * How a Responses stream ended, from its terminal event:
 * "completed", "incomplete" (a partial answer) or "failed".
 */
export function responsesTerminalOutcome(eventName, chunk) {
  const type = getOpenAIResponsesEventName(eventName, chunk);
  const status = chunk?.response?.status;
  if (type === "error" || type === "response.failed" || status === "failed") return "failed";
  if (type === "response.incomplete" || status === "incomplete") return "incomplete";
  return "completed";
}

const sharedEncoder = new TextEncoder();

// Encoded response.failed + [DONE] payload for aborted/stalled Responses passthrough streams
export function buildAbortedResponsesTerminalBytes() {
  return sharedEncoder.encode(`${formatIncompleteOpenAIResponsesStreamFailure()}data: [DONE]\n\n`);
}

// Synthesize a response.failed event for streams that close without a terminal event
export function formatIncompleteOpenAIResponsesStreamFailure() {
  return formatSSE({
    event: "response.failed",
    data: {
      type: "response.failed",
      response: {
        id: `resp_${Date.now()}`,
        status: "failed",
        error: {
          type: "stream_error",
          code: "stream_disconnected",
          message: "stream closed before response.completed"
        }
      }
    }
  }, FORMATS.OPENAI_RESPONSES);
}
