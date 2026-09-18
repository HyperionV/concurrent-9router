import test from "node:test";
import assert from "node:assert/strict";
import { deriveStablePrefixCacheKey } from "../../open-sse/utils/cacheKeyDerivation.js";

test("returns null for empty or non-object bodies", () => {
  assert.equal(deriveStablePrefixCacheKey(null), null);
  assert.equal(deriveStablePrefixCacheKey({}), null);
  assert.equal(deriveStablePrefixCacheKey({ messages: [] }), null);
});

test("produces deterministic hash for model + system prompt", () => {
  const body1 = {
    model: "grok-4.5-low",
    messages: [
      { role: "system", content: "You are an expert billing auditor." },
      { role: "user", content: "Audit transaction #101" },
    ],
  };
  const body2 = {
    model: "grok-4.5-low",
    messages: [
      { role: "system", content: "You are an expert billing auditor." },
      { role: "user", content: "A completely different user turn #999" },
    ],
  };
  const key1 = deriveStablePrefixCacheKey(body1);
  const key2 = deriveStablePrefixCacheKey(body2);
  assert.match(key1, /^pck_[0-9a-f]{16}$/);
  assert.equal(key1, key2);
});

test("produces identical hash regardless of tool declaration order", () => {
  const toolsA = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files",
        parameters: { type: "object" },
      },
    },
  ];
  const toolsB = [
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files",
        parameters: { type: "object" },
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
      },
    },
  ];

  const keyA = deriveStablePrefixCacheKey({
    model: "grok-4.5",
    tools: toolsA,
    instructions: "System",
  });
  const keyB = deriveStablePrefixCacheKey({
    model: "grok-4.5",
    tools: toolsB,
    instructions: "System",
  });
  assert.equal(keyA, keyB);
});

test("honors explicit body.prompt_cache_key if present", () => {
  const key = deriveStablePrefixCacheKey({
    prompt_cache_key: "custom-explicit-key",
  });
  assert.equal(key, "custom-explicit-key");
});
