import test from "node:test";
import assert from "node:assert/strict";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

test("CodexExecutor injects derived prompt_cache_key and aligns session_id header", async () => {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.4",
    instructions: "System charter for codex agent with deep tooling instructions.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
  };

  const req = executor.buildRequest({
    model: "gpt-5.4",
    body,
    credentials: { accessToken: "test-token" },
  });

  assert.match(req.transformedBody.prompt_cache_key, /^pck_[0-9a-f]{16}$/);
  assert.equal(req.headers.session_id, req.transformedBody.prompt_cache_key);
});

test("CodexExecutor sets prompt_cache_options ttl=30m for gpt-5.6 models", async () => {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.6-codex",
    instructions: "System charter for gpt-5.6 codex agent.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
  };

  const req = executor.buildRequest({
    model: "gpt-5.6-codex",
    body,
    credentials: { accessToken: "test-token" },
  });

  assert.deepEqual(req.transformedBody.prompt_cache_options, { ttl: "30m" });
});

test("CodexExecutor preserves explicit prompt_cache_key", async () => {
  const executor = new CodexExecutor();
  const body = {
    model: "gpt-5.4",
    prompt_cache_key: "custom-user-cache-key",
    instructions: "System charter for codex agent.",
    input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
  };

  const req = executor.buildRequest({
    model: "gpt-5.4",
    body,
    credentials: { accessToken: "test-token" },
  });

  assert.equal(req.transformedBody.prompt_cache_key, "custom-user-cache-key");
  assert.equal(req.headers.session_id, "custom-user-cache-key");
});
