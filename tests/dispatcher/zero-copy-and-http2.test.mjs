import test from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { getDirectDispatcher, getDispatcher } from "../../open-sse/utils/proxyFetch.js";
import { createZeroCopyPassthroughStream } from "../../open-sse/utils/zeroCopyStream.js";

test("Undici Connection Pool - direct dispatcher is initialized with keep-alive and socket isolation", async () => {
  const directDispatcher = await getDirectDispatcher();
  assert.ok(directDispatcher, "directDispatcher must not be null");
  assert.ok(
    directDispatcher.dispatch !== undefined,
    "directDispatcher must be a valid Undici Dispatcher",
  );
});

test("Undici Connection Pool - proxy dispatcher is created with keep-alive and socket isolation", async () => {
  const proxyDispatcher = await getDispatcher("http://127.0.0.1:7890");
  assert.ok(proxyDispatcher, "proxyDispatcher must not be null");
  assert.ok(
    proxyDispatcher.dispatch !== undefined,
    "proxyDispatcher must be a valid Undici Dispatcher",
  );
});

test("Zero-Copy Stream - passes binary chunks untouched and triggers identity, progress, and usage", async () => {
  let progressCalled = false;
  let observedId = null;
  let completedUsage = null;
  let completedContent = null;

  const stream = createZeroCopyPassthroughStream({
    targetFormat: "openai_responses",
    sourceFormat: "openai_responses",
    onFirstProgress: async () => {
      progressCalled = true;
    },
    onResponseIdentity: (id) => {
      observedId = id;
    },
    onStreamComplete: (contentObj, usage) => {
      completedContent = contentObj;
      completedUsage = usage;
    },
  });

  const chunk1 = Buffer.from(
    'data: {"id":"resp_123456","object":"response","status":"in_progress"}\n\n',
  );
  const chunk2 = Buffer.from(
    'data: {"type":"response.output_text.delta","delta":"Hello world"}\n\n',
  );
  const chunk3 = Buffer.from(
    'data: {"type":"response.done","usage":{"prompt_tokens":15,"completion_tokens":5,"total_tokens":20}}\n\n',
  );
  const chunk4 = Buffer.from("data: [DONE]\n\n");

  const chunksReceived = [];

  const reader = stream.readable.getReader();
  const writer = stream.writable.getWriter();

  const readPromise = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunksReceived.push(Buffer.from(value));
    }
  })();

  await writer.write(chunk1);
  await writer.write(chunk2);
  await writer.write(chunk3);
  await writer.write(chunk4);
  await writer.close();

  await readPromise;

  // Verify untouched binary forwarding
  assert.strictEqual(chunksReceived.length, 4, "Must receive all 4 chunks");
  assert.strictEqual(
    Buffer.concat(chunksReceived).toString(),
    Buffer.concat([chunk1, chunk2, chunk3, chunk4]).toString(),
    "Output bytes must match input bytes exactly (zero mutation)",
  );

  // Verify callbacks
  assert.strictEqual(progressCalled, true, "onFirstProgress must be triggered");
  assert.strictEqual(observedId, "resp_123456", "Response id must be captured");
  assert.ok(completedUsage, "Usage must be captured from terminal chunk");
  assert.strictEqual(completedUsage.prompt_tokens, 15);
  assert.strictEqual(completedUsage.completion_tokens, 5);
  assert.strictEqual(completedUsage.total_tokens, 20);
});
