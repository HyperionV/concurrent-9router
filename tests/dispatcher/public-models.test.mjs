import test from "node:test";
import assert from "node:assert/strict";
import { getPublicModelsList, resolveModelCapabilities } from "../../src/lib/publicModels.js";

test("resolveModelCapabilities identifies reasoning support and context windows", () => {
  // Grok 4.7
  const grokCaps = resolveModelCapabilities("grok-cli", "grok-4.7");
  assert.equal(grokCaps.capabilities.reasoning, true);
  assert.equal(grokCaps.capabilities.vision, true);
  assert.deepEqual(grokCaps.reasoning_efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(grokCaps.default_reasoning_effort, "high");
  assert.equal(grokCaps.context_window, 131072);

  // Codex GPT-6
  const codexCaps = resolveModelCapabilities("codex", "gpt-6.0-sol");
  assert.equal(codexCaps.capabilities.reasoning, true);
  assert.deepEqual(codexCaps.reasoning_efforts, ["none", "low", "medium", "high", "xhigh"]);
  assert.equal(codexCaps.default_reasoning_effort, "high");
  assert.equal(codexCaps.context_window, 200000);

  // Claude Opus 5.5
  const claudeCaps = resolveModelCapabilities("claude", "claude-opus-5-5");
  assert.equal(claudeCaps.capabilities.reasoning, true);
  assert.deepEqual(claudeCaps.reasoning_efforts, ["low", "medium", "high", "max"]);
  assert.equal(claudeCaps.max_output_tokens, 64000);

  // Image model
  const imgCaps = resolveModelCapabilities("codex", "gpt-5.5-image", { type: "image" });
  assert.equal(imgCaps.capabilities.image_generation, true);
  assert.equal(imgCaps.capabilities.tool_calling, false);
});

test("getPublicModelsList produces structured catalog with total count", async () => {
  const result = await getPublicModelsList();
  assert.equal(result.object, "list");
  assert.ok(typeof result.total_models === "number");
  assert.ok(Array.isArray(result.data));
  assert.ok(result.data.length > 0);

  // Validate properties on first item
  const item = result.data[0];
  assert.ok(typeof item.id === "string");
  assert.ok(typeof item.name === "string");
  assert.ok(typeof item.provider === "string");
  assert.ok(typeof item.capabilities === "object");
  assert.ok(Array.isArray(item.reasoning_efforts));
});
