/**
 * Stream-to-JSON Converter
 * Converts Responses API SSE stream to single JSON response
 * Used when client requests non-streaming but provider forces streaming (e.g., Codex)
 */

// SSE events end with a blank line; servers may use CRLF line endings.
const SSE_EVENT_SEPARATOR = /\r?\n\r?\n/;

const STREAM_ENDED_EARLY = {
  code: "stream_disconnected",
  message: "The upstream stream ended before the reply finished",
};

/**
 * Process a single SSE message and update state accordingly.
 */
function processSSEMessage(msg, state) {
  if (!msg.trim()) return;

  let eventName = null;
  const dataLines = [];
  for (const line of msg.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  const dataStr = dataLines.join("\n").trim();
  if (!dataStr || dataStr === "[DONE]") return;

  let parsed;
  try { parsed = JSON.parse(dataStr); }
  catch { return; }

  const eventType = eventName || parsed?.type || "";
  const status = parsed.response?.status;

  if (eventType === "response.created") {
    state.responseId = parsed.response?.id || state.responseId;
    state.created = parsed.response?.created_at || state.created;
  } else if (eventType === "response.output_item.done") {
    state.items.set(parsed.output_index ?? 0, parsed.item);
  } else if (eventType === "error" || eventType === "response.failed" || status === "failed") {
    // error and response.failed can arrive back to back; keep the first.
    if (state.status !== "failed") {
      state.status = "failed";
      state.error = parsed.error || parsed.response?.error || null;
    }
  } else if (eventType === "response.incomplete" || status === "incomplete") {
    state.status = "incomplete";
    state.incompleteDetails = parsed.response?.incomplete_details || null;
    state.usage = parsed.response?.usage || state.usage;
  } else if (eventType === "response.completed" || eventType === "response.done") {
    state.status = "completed";
    state.usage = parsed.response?.usage || state.usage;
  }
}

const EMPTY_USAGE = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

/**
 * Convert Responses API SSE stream to single JSON response.
 * `status` is "completed", "incomplete" or "failed"; a stream that closed
 * without a terminal event is "failed" with a stream_disconnected error.
 * @param {ReadableStream} stream - SSE stream from provider
 * @returns {Promise<Object>} Final JSON response in Responses API format
 */
export async function convertResponsesStreamToJson(stream) {
  if (!stream || typeof stream.getReader !== "function") {
    return { id: `resp_${Date.now()}`, object: "response", created_at: Math.floor(Date.now() / 1000), status: "failed", error: STREAM_ENDED_EARLY, output: [], usage: { ...EMPTY_USAGE } };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const state = {
    responseId: "",
    created: Math.floor(Date.now() / 1000),
    status: null,
    error: null,
    incompleteDetails: null,
    usage: { ...EMPTY_USAGE },
    items: new Map()
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split(SSE_EVENT_SEPARATOR);
      buffer = messages.pop() || "";

      for (const msg of messages) {
        processSSEMessage(msg, state);
      }
    }

    // Flush remaining buffer (last event may not end with a blank line)
    buffer += decoder.decode();
    if (buffer.trim()) {
      processSSEMessage(buffer, state);
    }
  } finally {
    reader.releaseLock();
  }

  // Build output array from accumulated items (ordered by index)
  const output = [];
  const maxIndex = state.items.size > 0 ? Math.max(...state.items.keys()) : -1;
  for (let i = 0; i <= maxIndex; i++) {
    output.push(state.items.get(i) || { type: "message", content: [], role: "assistant" });
  }

  const result = {
    id: state.responseId || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    object: "response",
    created_at: state.created,
    status: state.status || "failed",
    output,
    usage: state.usage
  };
  if (result.status === "failed") result.error = state.error || STREAM_ENDED_EARLY;
  if (result.status === "incomplete") result.incomplete_details = state.incompleteDetails;
  return result;
}
