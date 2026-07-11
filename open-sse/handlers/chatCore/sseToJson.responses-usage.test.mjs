/**
 * Grok CLI / Responses providers must use Responses SSE→JSON so usage is saved.
 * Regression: non-stream model tests hit Chat Completions SSE parser → zero tokens → no dashboard.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { FORMATS } from "../../translator/formats.js";
import { PROVIDERS } from "../../config/providers.js";
import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { isResponsesProvider } from "./sseToJsonHandler.js";

test("codex and grok-cli force Responses SSE transport", () => {
  assert.equal(PROVIDERS.codex?.forceStream, true);
  assert.equal(PROVIDERS["grok-cli"]?.forceStream, true);
  assert.equal(PROVIDERS.codex?.format, FORMATS.OPENAI_RESPONSES);
  assert.equal(PROVIDERS["grok-cli"]?.format, FORMATS.OPENAI_RESPONSES);
});

test("isResponsesProvider covers codex and grok-cli, not antigravity", () => {
  assert.equal(isResponsesProvider("codex"), true);
  assert.equal(isResponsesProvider("grok-cli"), true);
  assert.equal(isResponsesProvider("antigravity"), false);
  assert.equal(isResponsesProvider("claude"), false);
});

function encodeSseMessages(events) {
  return events
    .map(
      (e) =>
        `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
    )
    .join("");
}

test("convertResponsesStreamToJson extracts usage for dashboard write path", async () => {
  const sse = encodeSseMessages([
    {
      event: "response.created",
      data: {
        response: { id: "resp_test_1", created_at: 1_700_000_000 },
      },
    },
    {
      event: "response.output_item.done",
      data: {
        output_index: 0,
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hello from grok" }],
        },
      },
    },
    {
      event: "response.completed",
      data: {
        response: {
          usage: {
            input_tokens: 42,
            output_tokens: 7,
            total_tokens: 49,
          },
        },
      },
    },
  ]);

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });

  const json = await convertResponsesStreamToJson(stream);
  assert.equal(json.status, "completed");
  assert.equal(json.usage.input_tokens, 42);
  assert.equal(json.usage.output_tokens, 7);
  assert.equal(json.output[0]?.content?.[0]?.text, "hello from grok");
});
