import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "dispatcher-response-id-"),
);
process.env.DATA_DIR = tempRoot;

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { createStreamController } =
  await import("../../open-sse/utils/streamHandler.js");
const { handleNonStreamingResponse } =
  await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } =
  await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { handleStreamingResponse } =
  await import("../../open-sse/handlers/chatCore/streamingHandler.js");

function noopLogger() {
  return {
    logProviderResponse() {},
    logConvertedResponse() {},
    appendProviderChunk() {},
    appendConvertedChunk() {},
    appendOpenAIChunk() {},
  };
}

function stringStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

test("non-streaming handler reports response identity to dispatcher hooks", async () => {
  let responseId = null;

  await handleNonStreamingResponse({
    providerResponse: new Response(
      JSON.stringify({
        id: "resp-nonstream",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-5.4-low",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      {
        headers: { "content-type": "application/json" },
      },
    ),
    provider: "codex",
    model: "gpt-5.4-low",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    body: { input: "hi" },
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now() - 5,
    connectionId: "conn-1",
    apiKey: null,
    clientRawRequest: { endpoint: "/v1/responses" },
    onRequestSuccess: async () => {},
    reqLogger: noopLogger(),
    trackDone: () => {},
    appendLog: () => {},
    dispatcherHooks: {
      onStreamStarted: async () => {},
      onFirstProgress: async () => {},
      onResponseIdentity: async (id) => {
        responseId = id;
      },
    },
  });

  assert.equal(responseId, "resp-nonstream");
});

test("forced sse-to-json handler reports codex response identity", async () => {
  let responseId = null;
  const sse = [
    'event: response.created\ndata: {"response":{"id":"resp-forced","created_at":1710000000}}\n',
    'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}}\n',
    'event: response.completed\ndata: {"response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n',
  ].join("\n");

  await handleForcedSSEToJson({
    providerResponse: new Response(stringStream(sse), {
      headers: { "content-type": "text/event-stream" },
    }),
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    provider: "codex",
    model: "gpt-5.4-low",
    body: { input: "hi" },
    stream: false,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now() - 5,
    connectionId: "conn-1",
    apiKey: null,
    clientRawRequest: { endpoint: "/v1/responses" },
    onRequestSuccess: async () => {},
    trackDone: () => {},
    appendLog: () => {},
    dispatcherHooks: {
      onStreamStarted: async () => {},
      onFirstProgress: async () => {},
      onResponseIdentity: async (id) => {
        responseId = id;
      },
    },
  });

  assert.equal(responseId, "resp-forced");
});

test("streaming handler forwards response identity observed in sse stream", async () => {
  let responseId = null;
  const streamController = createStreamController({
    provider: "openai",
    model: "gpt-5.4-low",
  });
  const sse = [
    'data: {"id":"resp-stream","object":"chat.completion.chunk","created":1710000000,"model":"gpt-5.4-low","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n',
    "data: [DONE]\n\n",
  ].join("\n");

  const result = handleStreamingResponse({
    providerResponse: new Response(stringStream(sse), {
      headers: { "content-type": "text/event-stream" },
    }),
    provider: "openai",
    model: "gpt-5.4-low",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    userAgent: "",
    body: { messages: [{ role: "user", content: "hi" }], stream: true },
    stream: true,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now() - 5,
    connectionId: "conn-1",
    apiKey: null,
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    onRequestSuccess: async () => {},
    reqLogger: noopLogger(),
    toolNameMap: null,
    streamController,
    onStreamComplete: async () => {},
    dispatcherHooks: {
      onStreamStarted: async () => {},
      onFirstProgress: async () => {},
      onCompleted: async () => {},
      onResponseIdentity: async (id) => {
        responseId = id;
      },
    },
  });

  await result.response.text();
  assert.equal(responseId, "resp-stream");
});

test("streaming handler waits for async response identity persistence before continuing", async () => {
  let responseId = null;
  let releaseIdentity = null;
  const events = [];
  const identityGate = new Promise((resolve) => {
    releaseIdentity = resolve;
  });
  const streamController = createStreamController({
    provider: "openai",
    model: "gpt-5.4-low",
  });
  const sse = [
    'data: {"id":"resp-stream-await","object":"chat.completion.chunk","created":1710000000,"model":"gpt-5.4-low","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n',
    "data: [DONE]\n\n",
  ].join("\n");

  const result = handleStreamingResponse({
    providerResponse: new Response(stringStream(sse), {
      headers: { "content-type": "text/event-stream" },
    }),
    provider: "openai",
    model: "gpt-5.4-low",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    userAgent: "",
    body: { messages: [{ role: "user", content: "hi" }], stream: true },
    stream: true,
    translatedBody: null,
    finalBody: null,
    requestStartTime: Date.now() - 5,
    connectionId: "conn-1",
    apiKey: null,
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    onRequestSuccess: async () => {},
    reqLogger: noopLogger(),
    toolNameMap: null,
    streamController,
    onStreamComplete: async () => {},
    dispatcherHooks: {
      onStreamStarted: async () => {},
      onFirstProgress: async () => {
        events.push("first-progress");
      },
      onCompleted: async () => {
        events.push("completed");
      },
      onResponseIdentity: async (id) => {
        events.push("identity-start");
        responseId = id;
        await identityGate;
        events.push("identity-done");
      },
    },
  });

  const responseTextPromise = result.response.text();
  const earlyResult = await Promise.race([
    responseTextPromise.then(() => "done"),
    delay(20, "timeout"),
  ]);

  assert.equal(earlyResult, "timeout");
  assert.deepEqual(events, ["identity-start"]);

  releaseIdentity();

  const text = await responseTextPromise;
  await delay(0);

  assert.equal(responseId, "resp-stream-await");
  assert.match(text, /hello/);
  assert.ok(
    events.indexOf("identity-done") !== -1,
    "identity callback should finish before stream completes",
  );
  assert.ok(
    events.indexOf("first-progress") > events.indexOf("identity-done"),
    "first progress should happen only after response identity persistence finishes",
  );
});
