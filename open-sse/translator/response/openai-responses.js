/**
 * Translator: OpenAI Chat Completions → OpenAI Responses API (response)
 * Converts streaming chunks from Chat Completions to Responses API events
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";

/**
 * Translate OpenAI chunk to Responses API events
 * @returns {Array} Array of events with { event, data } structure
 */
export function openaiToOpenAIResponsesResponse(chunk, state) {
  if (!chunk) {
    return flushEvents(state);
  }
  
  if (!chunk.choices?.length) return [];
  
  const events = [];
  const nextSeq = () => ++state.seq;
  
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  const choice = chunk.choices[0];
  const idx = choice.index || 0;
  const delta = choice.delta || {};

  // Emit initial events
  if (!state.started) {
    state.started = true;
    state.responseId = chunk.id ? `resp_${chunk.id}` : state.responseId;
    
    emit("response.created", {
      type: "response.created",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress",
        background: false,
        error: null,
        output: []
      }
    });

    emit("response.in_progress", {
      type: "response.in_progress",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "in_progress"
      }
    });
  }

  // Handle reasoning_content
  if (delta.reasoning_content) {
    startReasoning(state, emit, idx);
    emitReasoningDelta(state, emit, delta.reasoning_content);
  }

  // Handle text content
  if (delta.content) {
    let content = delta.content;

    if (content.includes("<think>")) {
      state.inThinking = true;
      content = content.replace("<think>", "");
      startReasoning(state, emit, idx);
    }

    if (content.includes("</think>")) {
      const parts = content.split("</think>");
      const thinkPart = parts[0];
      const textPart = parts.slice(1).join("</think>");
      if (thinkPart) emitReasoningDelta(state, emit, thinkPart);
      closeReasoning(state, emit);
      state.inThinking = false;
      content = textPart;
    }

    if (state.inThinking && content) {
      emitReasoningDelta(state, emit, content);
      return events;
    }

    if (content) {
      // The answer starts, so thinking is over. Upstreams that send reasoning via
      // reasoning_content never emit "</think>", so close it here rather than at finish.
      closeReasoning(state, emit);
      emitTextContent(state, emit, idx, content);
    }
  }

  // Handle tool_calls
  if (delta.tool_calls) {
    closeMessage(state, emit, idx);
    for (const tc of delta.tool_calls) {
      emitToolCall(state, emit, tc);
    }
  }

  // Handle finish_reason
  if (choice.finish_reason) {
    state.responsesUsage = responsesUsageFromChatUsage(chunk.usage || state.usage);
    for (const i in state.msgItemAdded) closeMessage(state, emit, i);
    closeReasoning(state, emit);
    for (const i in state.funcCallIds) closeToolCall(state, emit, i);
    sendCompleted(state, emit);
  }

  return events;
}

// Helper functions
function startReasoning(state, emit, idx) {
  if (!state.reasoningId) {
    state.reasoningId = `rs_${state.responseId}_${idx}`;
    state.reasoningIndex = allocateOutputIndex(state);

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.reasoningIndex,
      item: { id: state.reasoningId, type: "reasoning", summary: [] }
    });

    emit("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: "" }
    });
    state.reasoningPartAdded = true;
  }
}

function emitReasoningDelta(state, emit, text) {
  if (!text) return;
  state.reasoningBuf += text;
  emit("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: state.reasoningId,
    output_index: state.reasoningIndex,
    summary_index: 0,
    delta: text
  });
}

function closeReasoning(state, emit) {
  if (state.reasoningId && !state.reasoningDone) {
    state.reasoningDone = true;
    
    emit("response.reasoning_summary_text.done", {
      type: "response.reasoning_summary_text.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      text: state.reasoningBuf
    });

    emit("response.reasoning_summary_part.done", {
      type: "response.reasoning_summary_part.done",
      item_id: state.reasoningId,
      output_index: state.reasoningIndex,
      summary_index: 0,
      part: { type: "summary_text", text: state.reasoningBuf }
    });

    const item = {
      id: state.reasoningId,
      type: "reasoning",
      summary: [{ type: "summary_text", text: state.reasoningBuf }]
    };
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: state.reasoningIndex,
      item
    });
    recordCompletedOutputItem(state, state.reasoningIndex, item);
  }
}

function emitTextContent(state, emit, idx, content) {
  if (!state.msgItemAdded[idx]) {
    state.msgItemAdded[idx] = true;
    outputIndexes(state).message[idx] = allocateOutputIndex(state);
    const msgId = `msg_${state.responseId}_${idx}`;

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndexes(state).message[idx],
      item: { id: msgId, type: "message", content: [], role: "assistant" }
    });
  }

  if (!state.msgContentAdded[idx]) {
    state.msgContentAdded[idx] = true;
    
    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: `msg_${state.responseId}_${idx}`,
      output_index: outputIndexes(state).message[idx],
      content_index: 0,
      part: { type: "output_text", annotations: [], logprobs: [], text: "" }
    });
  }

  emit("response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: `msg_${state.responseId}_${idx}`,
    output_index: outputIndexes(state).message[idx],
    content_index: 0,
    delta: content,
    logprobs: []
  });

  if (!state.msgTextBuf[idx]) state.msgTextBuf[idx] = "";
  state.msgTextBuf[idx] += content;
}

function closeMessage(state, emit, idx) {
  if (state.msgItemAdded[idx] && !state.msgItemDone[idx]) {
    state.msgItemDone[idx] = true;
    const fullText = state.msgTextBuf[idx] || "";
    const msgId = `msg_${state.responseId}_${idx}`;
    const outputIndex = outputIndexes(state).message[idx];

    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      text: fullText,
      logprobs: []
    });

    emit("response.content_part.done", {
      type: "response.content_part.done",
      item_id: msgId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", annotations: [], logprobs: [], text: fullText }
    });

    const item = {
      id: msgId,
      type: "message",
      status: "completed",
      content: [{ type: "output_text", annotations: [], logprobs: [], text: fullText }],
      role: "assistant"
    };
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item
    });
    recordCompletedOutputItem(state, outputIndex, item);
  }
}

function emitToolCall(state, emit, tc) {
  const tcIdx = tc.index ?? 0;
  const newCallId = tc.id;
  const funcName = tc.function?.name;

  if (funcName) state.funcNames[tcIdx] = funcName;

  if (!state.funcCallIds[tcIdx] && newCallId) {
    state.funcCallIds[tcIdx] = newCallId;
    outputIndexes(state).functionCall[tcIdx] = allocateOutputIndex(state);

    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndexes(state).functionCall[tcIdx],
      item: {
        id: `fc_${newCallId}`,
        type: "function_call",
        arguments: "",
        call_id: newCallId,
        name: state.funcNames[tcIdx] || ""
      }
    });
  }

  if (!state.funcArgsBuf[tcIdx]) state.funcArgsBuf[tcIdx] = "";

  if (tc.function?.arguments) {
    const refCallId = state.funcCallIds[tcIdx] || newCallId;
    if (refCallId) {
      emit("response.function_call_arguments.delta", {
        type: "response.function_call_arguments.delta",
        item_id: `fc_${refCallId}`,
        output_index: outputIndexes(state).functionCall[tcIdx],
        delta: tc.function.arguments
      });
    }
    state.funcArgsBuf[tcIdx] += tc.function.arguments;
  }
}

function closeToolCall(state, emit, idx) {
  const callId = state.funcCallIds[idx];
  if (callId && !state.funcItemDone[idx]) {
    const args = state.funcArgsBuf[idx] || "{}";
    const outputIndex = outputIndexes(state).functionCall[idx];

    emit("response.function_call_arguments.done", {
      type: "response.function_call_arguments.done",
      item_id: `fc_${callId}`,
      output_index: outputIndex,
      arguments: args
    });

    const item = {
      id: `fc_${callId}`,
      type: "function_call",
      status: "completed",
      arguments: args,
      call_id: callId,
      name: state.funcNames[idx] || ""
    };
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: outputIndex,
      item
    });
    recordCompletedOutputItem(state, outputIndex, item);

    state.funcItemDone[idx] = true;
    state.funcArgsDone[idx] = true;
  }
}

// Every item in a reply (reasoning, message, each tool call) has its own output_index, in the
// order the items were added: Chat choice and tool-call indexes each restart at 0, so reusing
// them makes the reasoning, the answer and the first tool call collide on index 0.
// Lazily created because stream.js can hand us a state it built itself rather than one from initState().
function allocateOutputIndex(state) {
  state.nextOutputIndex ??= 0;
  return state.nextOutputIndex++;
}

function outputIndexes(state) {
  state.outputIndexes ??= { message: {}, functionCall: {} };
  return state.outputIndexes;
}

// response.completed carries the finished Response, so response.output repeats the items already
// sent in response.output_item.done. Clients that rebuild the reply from the terminal event
// (LangChain's ChatOpenAI, the OpenAI SDK helpers) fail on a reply without it.
function recordCompletedOutputItem(state, outputIndex, item) {
  state.completedOutputItems ??= new Map();
  state.completedOutputItems.set(outputIndex, item);
}

function collectCompletedOutputItems(state) {
  if (!(state.completedOutputItems instanceof Map)) return [];
  return [...state.completedOutputItems.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, item]) => item);
}

// Responses usage from Chat Completions usage. Both detail objects are always present because
// Responses clients read their counts without checking that they exist.
function responsesUsageFromChatUsage(chatUsage) {
  if (!chatUsage || typeof chatUsage !== "object") return null;
  const inputTokens = chatUsage.prompt_tokens ?? chatUsage.input_tokens ?? 0;
  const outputTokens = chatUsage.completion_tokens ?? chatUsage.output_tokens ?? 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: chatUsage.prompt_tokens_details?.cached_tokens ?? chatUsage.cache_read_input_tokens ?? 0
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: chatUsage.completion_tokens_details?.reasoning_tokens ?? 0
    },
    total_tokens: inputTokens + outputTokens
  };
}

function sendCompleted(state, emit) {
  if (!state.completedSent) {
    state.completedSent = true;
    emit("response.completed", {
      type: "response.completed",
      response: {
        id: state.responseId,
        object: "response",
        created_at: state.created,
        status: "completed",
        background: false,
        error: null,
        output: collectCompletedOutputItems(state),
        ...(state.responsesUsage ? { usage: state.responsesUsage } : {})
      }
    });
  }
}

function flushEvents(state) {
  if (state.completedSent) return [];
  
  const events = [];
  const nextSeq = () => ++state.seq;
  const emit = (eventType, data) => {
    data.sequence_number = nextSeq();
    events.push({ event: eventType, data });
  };

  for (const i in state.msgItemAdded) closeMessage(state, emit, i);
  closeReasoning(state, emit);
  for (const i in state.funcCallIds) closeToolCall(state, emit, i);
  sendCompleted(state, emit);
  
  return events;
}

// currentToolCallId is intentionally sticky for the current turn so flush/completion
  // can still finalize as tool_calls even if the tool call was emitted before stream end.
function computeFinishReason(state) {
   return state.toolCallIndex > 0 || state.currentToolCallId
    ? "tool_calls"
    : "stop";
}

/**
 * Chat Completions usage from a Responses usage object, keeping cached and
 * reasoning token counts.
 */
function chatUsageFromResponsesUsage(responseUsage) {
  if (!responseUsage || typeof responseUsage !== "object") return null;
  const inputTokens = responseUsage.input_tokens || responseUsage.prompt_tokens || 0;
  const outputTokens = responseUsage.output_tokens || responseUsage.completion_tokens || 0;
  // input_tokens already includes cached tokens.
  const cachedTokens =
    responseUsage.input_tokens_details?.cached_tokens || responseUsage.cache_read_input_tokens || 0;
  const reasoningTokens = responseUsage.output_tokens_details?.reasoning_tokens || 0;

  const usage = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
  if (cachedTokens > 0) usage.prompt_tokens_details = { cached_tokens: cachedTokens };
  if (reasoningTokens > 0) usage.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  return usage;
}

function finishChunk(state, finishReason) {
  state.finishReasonSent = true;
  state.finishReason = finishReason; // Mark for usage injection in stream.js
  const chunk = {
    id: state.chatId || `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: state.created || Math.floor(Date.now() / 1000),
    model: state.model || "unknown",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
  if (state.usage && typeof state.usage === "object") chunk.usage = state.usage;
  return chunk;
}

/**
 * A failed reply ends the stream with an OpenAI stream error object, which
 * OpenAI clients raise as an error. It is never sent as answer text.
 */
function failureChunk(state, error) {
  state.finishReasonSent = true;
  state.outcome = "failed";
  return {
    error: {
      message: error?.message || "The upstream model reply failed",
      type: error?.type || "upstream_error",
      code: error?.code || null,
    },
  };
}

/**
 * Translate OpenAI Responses API chunk to OpenAI Chat Completions format
 * This is for when Codex returns data and we need to send it to an OpenAI-compatible client
 */
export function openaiResponsesToOpenAIResponse(chunk, state) {
  if (!chunk) {
    // Flush: the upstream stream closed. Without a terminal event the reply
    // never finished, so the client must see an error, not a normal stop.
    if (state.finishReasonSent) return null;
    return failureChunk(state, {
      message: "The upstream stream ended before the reply finished",
      code: "stream_disconnected",
    });
  }

  // Handle different event types from Responses API
  const eventType = chunk.type || chunk.event;
  const data = chunk.data || chunk;

  // Initialize state
  if (!state.started) {
    state.started = true;
    state.chatId = `chatcmpl-${Date.now()}`;
    state.created = Math.floor(Date.now() / 1000);
    state.toolCallIndex = 0;
    state.currentToolCallId = null;
  }

  // Text content delta
  if (eventType === "response.output_text.delta") {
    const delta = data.delta || "";
    if (!delta) return null;

    return {
      id: state.chatId,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model || "unknown",
      choices: [{
        index: 0,
        delta: { content: delta },
        finish_reason: null
      }]
    };
  }

  // Text content done (ignore, we handle via delta)
  if (eventType === "response.output_text.done") {
    return null;
  }

  // Function call started (standard function_call or custom_tool_call)
  if (eventType === "response.output_item.added" && (data.item?.type === "function_call" || data.item?.type === "custom_tool_call")) {
    const item = data.item;
    state.currentToolCallId = item.call_id || `call_${Date.now()}`;

    return {
      id: state.chatId,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model || "unknown",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: state.toolCallIndex,
            id: state.currentToolCallId,
            type: "function",
            function: {
              name: item.name || "",
              arguments: ""
            }
          }]
        },
        finish_reason: null
      }]
    };
  }

  // Function call arguments delta (standard or custom_tool_call variant)
  if (eventType === "response.function_call_arguments.delta" || eventType === "response.custom_tool_call_input.delta") {
    const argsDelta = data.delta || "";
    if (!argsDelta) return null;

    state.toolArgsEmitted ??= new Set();
    state.toolArgsEmitted.add(state.toolCallIndex);

    return {
      id: state.chatId,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model || "unknown",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: state.toolCallIndex,
            function: { arguments: argsDelta }
          }]
        },
        finish_reason: null
      }]
    };
  }

  // Function call done (standard or custom_tool_call variant)
  if (eventType === "response.output_item.done" && (data.item?.type === "function_call" || data.item?.type === "custom_tool_call")) {
    const fullArgs = data.item?.arguments;
    state.toolArgsEmitted ??= new Set();
    const idx = state.toolCallIndex;
    const addedAlready = state.currentToolCallId != null;
    if (typeof fullArgs === "string" && fullArgs && !state.toolArgsEmitted.has(idx)) {
      state.toolArgsEmitted.add(idx);
      state.toolCallIndex++;
      state.currentToolCallId = null;
      return {
        id: state.chatId,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model || "unknown",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: idx,
              ...(addedAlready
                ? {}
                : {
                    id: data.item.call_id || data.item.id || `call_${Date.now()}`,
                    type: "function",
                  }),
              function: {
                ...(addedAlready
                  ? {}
                  : data.item.name
                    ? { name: data.item.name }
                    : {}),
                arguments: fullArgs,
              },
            }],
          },
          finish_reason: null,
        }],
      };
    }
    state.currentToolCallId = null;
    state.toolCallIndex++;
    return null;
  }

  // Response completed / done
  const terminalStatus =
    eventType === "response.done" ? data.response?.status : null;

  // Error events from Responses API (e.g. model_not_found). error and
  // response.failed can arrive back to back; only the first is reported.
  if (eventType === "error" || eventType === "response.failed" || terminalStatus === "failed") {
    if (state.finishReasonSent) return null;
    state.error = data.error || data.response?.error || null;
    return failureChunk(state, state.error);
  }

  // Cut short (output limit or content filter): a real but partial answer.
  if (eventType === "response.incomplete" || terminalStatus === "incomplete") {
    state.usage = chatUsageFromResponsesUsage(data.response?.usage) || state.usage;
    if (state.finishReasonSent) return null;
    state.outcome = "incomplete";
    const reason = data.response?.incomplete_details?.reason;
    return finishChunk(state, reason === "content_filter" ? "content_filter" : "length");
  }

  if (eventType === "response.completed" || eventType === "response.done") {
    state.usage = chatUsageFromResponsesUsage(data.response?.usage) || state.usage;
    if (state.finishReasonSent) return null;
    state.outcome = "completed";
    return finishChunk(state, computeFinishReason(state));
  }

  // Reasoning summary / reasoning text delta → emit as reasoning_content for client thinking display
  if (
    eventType === "response.reasoning_summary_text.delta" ||
    eventType === "response.reasoning_text.delta" ||
    eventType === "response.reasoning.delta"
  ) {
    const delta = data.delta || data.text || "";
    if (!delta) return null;

    return {
      id: state.chatId,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model || "unknown",
      choices: [{
        index: 0,
        delta: { reasoning_content: delta },
        finish_reason: null
      }]
    };
  }

  // Ignore other events
  return null;
}

// Register both directions
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, null, openaiToOpenAIResponsesResponse);
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, null, openaiResponsesToOpenAIResponse);
