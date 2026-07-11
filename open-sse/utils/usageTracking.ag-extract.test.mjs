/**
 * Antigravity/Gemini usage extraction for Usage overview (by-model table).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { extractUsage, hasValidUsage } from "./usageTracking.js";

test("extractUsage reads AG nested response.usageMetadata with thinking tokens", () => {
  const usage = extractUsage({
    response: {
      candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
      usageMetadata: {
        promptTokenCount: 120,
        candidatesTokenCount: 0,
        thoughtsTokenCount: 40,
        totalTokenCount: 160,
      },
    },
  });

  assert.ok(usage);
  assert.equal(usage.prompt_tokens, 120);
  // completion includes thoughts (thinking models)
  assert.equal(usage.completion_tokens, 40);
  assert.equal(usage.reasoning_tokens, 40);
  assert.equal(hasValidUsage(usage), true);
});

test("extractUsage top-level usageMetadata still works", () => {
  const usage = extractUsage({
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      totalTokenCount: 15,
    },
  });
  assert.equal(usage.prompt_tokens, 10);
  assert.equal(usage.completion_tokens, 5);
});
