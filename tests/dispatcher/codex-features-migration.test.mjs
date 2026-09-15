import test from "node:test";
import assert from "node:assert/strict";

import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

test("parseQuotaData correctly normalizes standard, review, and spark quota windows", () => {
  const mockCodexUsage = {
    plan: "team",
    quotas: {
      session: { used: 20, total: 100, remaining: 80, resetAt: "2026-08-22T05:00:00.000Z" },
      weekly: { used: 40, total: 100, remaining: 60, resetAt: "2026-08-28T05:00:00.000Z" },
      review_session: { used: 5, total: 100, remaining: 95, resetAt: "2026-08-22T05:00:00.000Z" },
      review_weekly: { used: 10, total: 100, remaining: 90, resetAt: "2026-08-28T05:00:00.000Z" },
      spark_session: { used: 12, total: 100, remaining: 88, resetAt: "2026-08-22T05:00:00.000Z" },
      spark_weekly: { used: 25, total: 100, remaining: 75, resetAt: "2026-08-28T05:00:00.000Z" },
    },
  };

  const parsed = parseQuotaData("codex", mockCodexUsage);

  const sparkSession = parsed.find((q) => q.name === "Spark (5h)");
  const sparkWeekly = parsed.find((q) => q.name === "Spark (Weekly)");
  const session = parsed.find((q) => q.name === "5h");
  const weekly = parsed.find((q) => q.name === "Weekly");
  const reviewSession = parsed.find((q) => q.name === "Review (5h)");
  const reviewWeekly = parsed.find((q) => q.name === "Review (Weekly)");

  assert.ok(sparkSession, "Spark (5h) should be defined");
  assert.equal(sparkSession.used, 12);
  assert.equal(sparkSession.remaining, 88);

  assert.ok(sparkWeekly, "Spark (Weekly) should be defined");
  assert.equal(sparkWeekly.used, 25);
  assert.equal(sparkWeekly.remaining, 75);

  assert.ok(session, "5h should be defined");
  assert.equal(session.used, 20);
  assert.equal(session.remaining, 80);

  assert.ok(weekly, "Weekly should be defined");
  assert.equal(weekly.used, 40);
  assert.equal(weekly.remaining, 60);

  assert.ok(reviewSession, "Review (5h) should be defined");
  assert.equal(reviewSession.used, 5);

  assert.ok(reviewWeekly, "Review (Weekly) should be defined");
  assert.equal(reviewWeekly.used, 10);
});

test("CodexExecutor handles GPT-5.6 Sol / Terra ultra reasoning level override", () => {
  const executor = new CodexExecutor();

  const reqSol = executor.buildRequest({
    model: "gpt-5.6-sol-ultra",
    body: { input: "Hello" },
    credentials: { connectionId: "conn-1" },
  });
  assert.equal(reqSol.transformedBody.model, "gpt-5.6-sol");
  assert.equal(reqSol.transformedBody.reasoning.effort, "ultra");

  const reqTerra = executor.buildRequest({
    model: "gpt-5.6-terra-ultra",
    body: { input: "Hello" },
    credentials: { connectionId: "conn-1" },
  });
  assert.equal(reqTerra.transformedBody.model, "gpt-5.6-terra");
  assert.equal(reqTerra.transformedBody.reasoning.effort, "ultra");
});

test("CodexExecutor normalizes Luna ultra to max and standard codex ultra/max to xhigh", () => {
  const executor = new CodexExecutor();

  const reqLuna = executor.buildRequest({
    model: "gpt-5.6-luna-ultra",
    body: { input: "Hello" },
    credentials: { connectionId: "conn-1" },
  });
  assert.equal(reqLuna.transformedBody.model, "gpt-5.6-luna");
  assert.equal(reqLuna.transformedBody.reasoning.effort, "max");

  const reqStandardMax = executor.buildRequest({
    model: "gpt-5.3-codex-max",
    body: { input: "Hello" },
    credentials: { connectionId: "conn-1" },
  });
  assert.equal(reqStandardMax.transformedBody.model, "gpt-5.3-codex");
  assert.equal(reqStandardMax.transformedBody.reasoning.effort, "xhigh");

  const reqStandardUltra = executor.buildRequest({
    model: "gpt-5.3-codex-ultra",
    body: { input: "Hello" },
    credentials: { connectionId: "conn-1" },
  });
  assert.equal(reqStandardUltra.transformedBody.model, "gpt-5.3-codex");
  assert.equal(reqStandardUltra.transformedBody.reasoning.effort, "xhigh");
});

test("openaiResponsesToOpenAIResponse translates reasoning deltas to reasoning_content", async () => {
  const { openaiResponsesToOpenAIResponse } = await import("../../open-sse/translator/response/openai-responses.js");
  const state = {};

  const reasoningChunk = openaiResponsesToOpenAIResponse({
    type: "response.reasoning_summary_text.delta",
    data: { delta: "Let me think about this step." }
  }, state);

  assert.ok(reasoningChunk, "Should return a chunk for reasoning delta");
  assert.equal(reasoningChunk.choices[0].delta.reasoning_content, "Let me think about this step.");
});

test("CodexExecutor _peekSseOverloaded unblocks immediately on reasoning deltas without buffering", async () => {
  const executor = new CodexExecutor();

  // Create a mock stream that sends reasoning deltas
  const ssePayload = 'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Analyzing requirements..."}\n\n';
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(ssePayload));
      // Stream intentionally left open to prove peek breaks early on the first chunk rather than waiting for EOF
    },
  });

  const mockResponse = new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

  const peek = await executor._peekSseOverloaded(mockResponse, { buildReplacement: true });
  assert.equal(peek.matched, null, "Should not match any error pattern");
  assert.equal(peek.accountFallback, false, "Should not trigger account fallback");
  assert.ok(peek.replacementBody, "Should produce replacementBody immediately");

  // Read replacementBody to verify content is preserved intact
  const reader = peek.replacementBody.getReader();
  const { value } = await reader.read();
  const decoded = new TextDecoder().decode(value);
  assert.ok(decoded.includes("response.reasoning_summary_text.delta"), "Original reasoning event preserved");
  await reader.cancel();
});

test("stripCodexUnsupportedPatterns removes Unicode-property regexes and preserves standard schemas", async () => {
  const { stripCodexUnsupportedPatterns } = await import("../../open-sse/utils/codexToolSchema.js");

  const schema = {
    type: "object",
    properties: {
      badPattern: { type: "string", pattern: "^(?!__.*__$)[^\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}]{1,200}$" },
      goodPattern: { type: "string", pattern: "^[a-zA-Z0-9_-]+$" },
      nested: {
        type: "object",
        properties: {
          innerBad: { type: "string", pattern: "^\\p{L}+$" },
        },
      },
    },
  };

  const cleaned = stripCodexUnsupportedPatterns(schema);
  assert.equal(cleaned.properties.badPattern.pattern, undefined, "Unicode pattern removed");
  assert.equal(cleaned.properties.goodPattern.pattern, "^[a-zA-Z0-9_-]+$", "Valid pattern preserved");
  assert.equal(cleaned.properties.nested.properties.innerBad.pattern, undefined, "Nested Unicode pattern removed");
  // Original source object intact
  assert.ok(schema.properties.badPattern.pattern.includes("\\p{Cc}"));
});

test("GrokCliExecutor defaults reasoning effort to low for fast query response", async () => {
  const { GrokCliExecutor } = await import("../../open-sse/executors/grok-cli.js");
  const executor = new GrokCliExecutor();

  const body = {
    model: "grok-3",
    input: [{ role: "user", content: "hello" }],
  };

  const transformed = executor.transformRequest("grok-3", body, true, { connectionId: "test-conn" });
  assert.equal(transformed.reasoning.effort, "low", "Default reasoning effort should be low");
  assert.equal(transformed.reasoning.summary, "concise");
});

test("resolveConversationKey generates deterministic prefix hash for prompt-cache affinity", async () => {
  const { resolveConversationKey } = await import("../../src/lib/dispatcher/conversationAffinity.js");

  // Multi-turn chat turn 1
  const turn1 = {
    messages: [
      { role: "system", content: "You are a helpful coding assistant specialized in Node.js and TypeScript." },
      { role: "user", content: "Hello, how do I create an HTTP server?" },
    ],
  };

  // Multi-turn chat turn 2 (new messages appended, but first system prompt matches)
  const turn2 = {
    messages: [
      { role: "system", content: "You are a helpful coding assistant specialized in Node.js and TypeScript." },
      { role: "user", content: "Hello, how do I create an HTTP server?" },
      { role: "assistant", content: "Here is how to create an HTTP server..." },
      { role: "user", content: "Can you add TLS/HTTPS to that?" },
    ],
  };

  const key1 = resolveConversationKey({ body: turn1 });
  const key2 = resolveConversationKey({ body: turn2 });

  assert.ok(key1 && key1.startsWith("pfx_"), `Key 1 should be a prefix hash: ${key1}`);
  assert.equal(key1, key2, "Turn 1 and Turn 2 should share identical prefix cache affinity key");

  // Explicit conversation ID should always override prefix hash
  const explicitKey = resolveConversationKey({
    body: { ...turn1, conversation_id: "conv-12345" },
  });
  assert.equal(explicitKey, "conv-12345", "Explicit conversation_id should take precedence");
});

test("waitForLease acquires lease quickly with adaptive fast polling", async () => {
  const { waitForLease } = await import("../../src/lib/dispatcher/executeCodexAttempt.js");

  let calls = 0;
  const mockDispatcher = {
    tryLeaseRequest: async () => {
      calls++;
      // Return lease on the second poll (after ~25ms)
      if (calls >= 2) {
        return { leaseId: "lease-fast-1", connectionId: "conn-1" };
      }
      return null;
    },
  };

  const start = Date.now();
  const lease = await waitForLease(mockDispatcher, "req-1", 500);
  const elapsed = Date.now() - start;

  assert.ok(lease, "Should acquire lease");
  assert.equal(lease.leaseId, "lease-fast-1");
  assert.equal(calls, 2);
  assert.ok(elapsed < 80, `Should acquire lease in under 80ms (was ${elapsed}ms)`);
});

test("Codex and Grok-CLI have 10s connect timeout guardrails configured", async () => {
  const { PROVIDERS } = await import("../../open-sse/config/providers.js");
  assert.equal(PROVIDERS.codex.timeoutMs, 10000, "Codex connect timeout should be 10000ms");
  assert.equal(PROVIDERS["grok-cli"].timeoutMs, 10000, "Grok-CLI connect timeout should be 10000ms");
});


