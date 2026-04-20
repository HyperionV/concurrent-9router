import test from "node:test";
import assert from "node:assert/strict";

import { createSSEStream } from "./stream.js";
import { FORMATS } from "../translator/formats.js";

function encodeSseLine(payload) {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n`);
}

async function drainReadable(readable) {
  const reader = readable.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

test("stream close waits for async first-progress callback", async () => {
  const timeline = [];
  let releaseFirstProgress;
  const firstProgressDone = new Promise((resolve) => {
    releaseFirstProgress = () => {
      timeline.push("first-progress-finished");
      resolve();
    };
  });

  const stream = createSSEStream({
    mode: "passthrough",
    sourceFormat: FORMATS.OPENAI,
    targetFormat: FORMATS.OPENAI,
    provider: "codex",
    model: "gpt-test",
    onFirstProgress: async () => {
      timeline.push("first-progress-started");
      await firstProgressDone;
    },
  });

  const readDone = drainReadable(stream.readable).then(() => {
    timeline.push("read-finished");
  });

  const writeDone = (async () => {
    const writer = stream.writable.getWriter();
    try {
      await writer.write(
        encodeSseLine({
          id: "chatcmpl_test",
          choices: [{ delta: { content: "hello" } }],
        }),
      );
      timeline.push("write-finished");
      await writer.close();
      timeline.push("close-finished");
    } finally {
      writer.releaseLock();
    }
  })();

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(timeline, ["first-progress-started"]);

  releaseFirstProgress();
  await writeDone;
  await readDone;

  assert.equal(timeline[0], "first-progress-started");
  assert.equal(timeline[1], "first-progress-finished");
  assert.ok(
    timeline.indexOf("write-finished") >
      timeline.indexOf("first-progress-finished"),
  );
  assert.ok(
    timeline.indexOf("close-finished") >
      timeline.indexOf("first-progress-finished"),
  );
  assert.ok(timeline.includes("read-finished"));
});
