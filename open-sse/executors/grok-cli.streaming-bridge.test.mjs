import test from "node:test";
import assert from "node:assert/strict";

import {
  isOpenAIResponsesTerminalEvent,
  getOpenAIResponsesEventName,
} from "../utils/responsesStreamHelpers.js";
import {
  GrokCliExecutor,
  normalizeGrokCliInput,
  isNativeGrokCliItemId,
} from "./grok-cli.js";
import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { convertResponsesStreamToJson } from "../transformer/streamToJsonConverter.js";
import { createSSEStream } from "../utils/stream.js";

test("isOpenAIResponsesTerminalEvent correctly identifies response.done", () => {
  assert.equal(
    isOpenAIResponsesTerminalEvent("response.done", { type: "response.done" }),
    true,
  );
  assert.equal(
    isOpenAIResponsesTerminalEvent(null, { type: "response.done" }),
    true,
  );
  assert.equal(
    isOpenAIResponsesTerminalEvent("response.completed", { type: "response.completed" }),
    true,
  );
  assert.equal(
    isOpenAIResponsesTerminalEvent("response.output_item.done", { type: "response.output_item.done" }),
    false,
  );
  assert.equal(
    isOpenAIResponsesTerminalEvent(null, { response: { status: "done" } }),
    true,
  );
});

test("streamToJsonConverter completes cleanly on response.done", async () => {
  const chunks = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message","role":"assistant"}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello world"}\n\n',
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","content":[{"type":"text","text":"Hello world"}]}}\n\n',
    'event: response.done\ndata: {"type":"response.done","response":{"id":"resp_1","status":"completed","usage":{"total_tokens":15}}}\n\n',
    'data: [DONE]\n\n',
  ];

  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      controller.close();
    },
  });

  const json = await convertResponsesStreamToJson(stream);
  assert.ok(json);
  assert.equal(json.id, "resp_1");
  assert.equal(json.status, "completed");
  assert.equal(json.output?.[0]?.content?.[0]?.text, "Hello world");
  assert.equal(json.usage?.total_tokens, 15);
});

test("translateResponse extracts monolithic tool arguments from response.output_item.done", () => {
  const state = initState(FORMATS.OPENAI);
  const event = {
    type: "response.output_item.done",
    item: {
      id: "fc_123",
      type: "function_call",
      name: "get_weather",
      call_id: "call_abc",
      arguments: '{"location":"San Francisco"}',
    },
  };

  const translated = translateResponse(
    FORMATS.OPENAI_RESPONSES,
    FORMATS.OPENAI,
    event,
    state,
  );

  assert.ok(Array.isArray(translated));
  const toolCallChunk = translated.find(
    (chunk) => chunk?.choices?.[0]?.delta?.tool_calls?.length > 0,
  );
  assert.ok(toolCallChunk, "Expected tool_calls chunk emitted");
  const toolCall = toolCallChunk.choices[0].delta.tool_calls[0];
  assert.equal(toolCall.function.name, "get_weather");
  assert.equal(toolCall.function.arguments, '{"location":"San Francisco"}');
});

test("normalizeGrokCliInput cleans up tools, reasoning, and passthrough metadata", () => {
  const body = {
    input: [
      {
        type: "message",
        role: "user",
        content: "Run test",
        internal_chat_message_metadata_passthrough: { hidden: true },
      },
      {
        type: "custom_tool_call",
        id: "call_1",
        name: "test_tool",
        input: { key: "val" },
      },
      {
        type: "custom_tool_call_output",
        id: "call_1",
        output: { result: "ok" },
      },
      {
        // Orphaned tool output with no matching call_id
        type: "function_call_output",
        call_id: "orphan_call",
        output: "nothing",
      },
    ],
  };

  const result = normalizeGrokCliInput(body);
  assert.equal(result.input.length, 3);
  assert.equal(result.input[0].internal_chat_message_metadata_passthrough, undefined);
  assert.equal(result.input[1].type, "function_call");
  assert.equal(result.input[1].name, "test_tool");
  assert.equal(
    result.input[1].arguments,
    JSON.stringify({ input: JSON.stringify({ key: "val" }) }),
  );
  assert.equal(result.input[2].type, "function_call_output");
  assert.equal(result.input[2].output, JSON.stringify({ result: "ok" }));
});

test("GrokCliExecutor maintains isolation across concurrent executions using AsyncLocalStorage", async () => {
  const executor = new GrokCliExecutor();

  // Test transformRequest isolates monotonic turns per session
  const bA = { input: [{ role: "user", content: "1" }] };
  const bB = { input: [{ role: "user", content: "1" }, { role: "user", content: "2" }] };
  executor.transformRequest("grok-4.5", bA, true, { connectionId: "conn-A" });
  assert.equal(executor._currentTurnIdx, 1);

  executor.transformRequest("grok-4.5", bB, true, { connectionId: "conn-B" });
  assert.equal(executor._currentTurnIdx, 2);
});

test("createSSEStream does not inject false response.failed on response.done", async () => {
  const stream = createSSEStream({
    mode: "translate",
    targetFormat: FORMATS.OPENAI_RESPONSES,
    sourceFormat: FORMATS.OPENAI_RESPONSES,
  });

  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  const chunks = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_100"}}\n\n',
    'event: response.done\ndata: {"type":"response.done","response":{"id":"resp_100","status":"completed"}}\n\n',
    'data: [DONE]\n\n',
  ];

  const readerPromise = (async () => {
    let fullOutput = "";
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      fullOutput += decoder.decode(value);
    }
    return fullOutput;
  })();

  for (const chunk of chunks) {
    await writer.write(new TextEncoder().encode(chunk));
  }
  await writer.close();

  const fullOutput = await readerPromise;

  assert.ok(!fullOutput.includes("stream_disconnected"), "Must NOT inject stream_disconnected failure on response.done");
  assert.ok(!fullOutput.includes("response.failed"), "Must NOT synthesize response.failed");
  assert.ok(fullOutput.includes("[DONE]"), "Must include terminal [DONE]");
});
