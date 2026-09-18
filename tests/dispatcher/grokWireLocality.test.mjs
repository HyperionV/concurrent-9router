import test from "node:test";
import assert from "node:assert/strict";
import { GrokCliExecutor } from "../../open-sse/executors/grok-cli.js";

test("GrokCliExecutor wire locality injects deterministic x-grok-conv-id and prompt_cache_key from prefix hash", async () => {
  const executor = new GrokCliExecutor();
  const body = {
    model: "grok-4.5-low",
    messages: [
      { role: "system", content: "You are an expert billing auditor with a large prompt charter." },
      { role: "user", content: "Audit transaction #101" },
    ],
  };

  const transformed = executor.transformRequest("grok-4.5-low", body, true, {
    connectionId: "conn-123",
  });
  assert.match(transformed.prompt_cache_key, /^pck_[0-9a-f]{16}$/);

  const headers = executor.buildHeaders({ connectionId: "conn-123" }, true);
  assert.equal(headers["x-grok-conv-id"], transformed.prompt_cache_key);
  assert.equal(headers["x-grok-session-id"], transformed.prompt_cache_key);
});

test("GrokCliExecutor preserves explicit conversation_id or prompt_cache_key if provided", async () => {
  const executor = new GrokCliExecutor();
  const body = {
    model: "grok-4.5-low",
    conversation_id: "agent-session-42",
    messages: [
      { role: "system", content: "Test System Charter" },
      { role: "user", content: "Hello" },
    ],
  };

  const transformed = executor.transformRequest("grok-4.5-low", body, true, {
    connectionId: "conn-123",
  });
  assert.equal(transformed.prompt_cache_key, "agent-session-42");

  const headers = executor.buildHeaders({ connectionId: "conn-123" }, true);
  assert.equal(headers["x-grok-conv-id"], "agent-session-42");
  assert.equal(headers["x-grok-session-id"], "agent-session-42");
});
