import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveConversationKey,
  isCachePrefixKey,
} from "../../src/lib/dispatcher/conversationAffinity.js";

test("resolveConversationKey prioritizes Tier 1 (previous_response_id) over everything", () => {
  const key = resolveConversationKey({
    body: {
      previous_response_id: "resp_12345",
      conversation_id: "conv_67890",
      instructions: "System prompt",
    },
  });
  assert.equal(key, "resp_12345");
  assert.equal(isCachePrefixKey(key), false);
});

test("resolveConversationKey prioritizes Tier 2 (conversation_id) over Tier 3 (prefix key)", () => {
  const key = resolveConversationKey({
    body: {
      conversation_id: "conv_67890",
      model: "grok-4.5-low",
      instructions: "System prompt",
    },
  });
  assert.equal(key, "conv_67890");
  assert.equal(isCachePrefixKey(key), false);
});

test("resolveConversationKey falls back to Tier 3 (canonical prefix key) producing pck_ hash", () => {
  const key = resolveConversationKey({
    body: {
      model: "grok-4.5-low",
      messages: [{ role: "system", content: "A long 18k system prompt..." }],
    },
  });
  assert.match(key, /^pck_[0-9a-f]{16}$/);
  assert.equal(isCachePrefixKey(key), true);
});

test("isCachePrefixKey identifies both pck_ and legacy pfx_ keys as soft prefix cache keys", () => {
  assert.equal(isCachePrefixKey("pck_0123456789abcdef"), true);
  assert.equal(isCachePrefixKey("pfx_abcdef01"), true);
  assert.equal(isCachePrefixKey("conv_12345"), false);
  assert.equal(isCachePrefixKey(null), false);
});
