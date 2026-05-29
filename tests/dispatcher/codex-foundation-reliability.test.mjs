import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BaseExecutor } from "open-sse/executors/base.js";
import { CodexExecutor } from "open-sse/executors/codex.js";
import {
  DEFAULT_TIMEOUT_POLICY,
  classifyAttemptTimeout,
} from "@/lib/dispatcher/timeoutPolicy.js";
import { DISPATCH_TIMEOUT_KIND } from "@/lib/dispatcher/types.js";
import { DefaultExecutor } from "open-sse/executors/default.js";
import { parseUpstreamError, createErrorResult } from "open-sse/utils/error.js";
import { openaiToClaudeResponse } from "open-sse/translator/response/openai-to-claude.js";
import {
  getAccessToken,
  refreshCodexToken,
  isUnrecoverableRefreshError,
} from "open-sse/services/tokenRefresh.js";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-codex-foundation-"));
}

function makeClaudeState() {
  return {
    messageStartSent: false,
    textBlockStarted: false,
    textBlockClosed: false,
    thinkingBlockStarted: false,
    toolCalls: new Map(),
  };
}

test("Codex executor hardens request shape and preserves managed dispatcher session", async () => {
  const executor = new CodexExecutor();
  const request = executor.buildRequest({
    model: "gpt-5.3-codex-high",
    stream: true,
    credentials: {
      connectionId: "conn_123",
      providerSpecificData: {
        dispatchSessionId: "dispatch_session_123",
        chatgptAccountId: "acct_123",
      },
    },
    body: {
      input: [
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "rules" }],
        },
        { type: "item_reference", id: "rs_deadbeef" },
        {
          type: "message",
          role: "assistant",
          id: "msg_deadbeef",
          content: [{ type: "output_text", text: "prior" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "work" }],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "Read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { file_path: { type: "string" } },
            },
          },
        },
        { type: "unknown_hosted_tool" },
      ],
      tool_choice: { type: "function", name: "Read" },
      previous_response_id: "resp_deadbeef",
      temperature: 0.7,
      metadata: { unsafe: true },
    },
  });

  assert.equal(request.sessionId, "dispatch_session_123");
  assert.equal(request.headers.session_id, "dispatch_session_123");
  assert.equal(request.headers.originator, "codex_cli_rs");
  assert.equal(request.headers["chatgpt-account-id"], "acct_123");

  assert.equal(
    request.transformedBody.prompt_cache_key,
    "dispatch_session_123",
  );
  assert.equal(request.transformedBody.input[0].role, "system");
  assert.equal(
    request.transformedBody.input.some(
      (item) => item.type === "item_reference",
    ),
    false,
  );
  assert.equal("id" in request.transformedBody.input[1], false);
  assert.equal(request.transformedBody.tools.length, 1);
  assert.deepEqual(request.transformedBody.tools[0], {
    type: "function",
    name: "Read",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { file_path: { type: "string" } },
    },
  });
  assert.equal(request.transformedBody.model, "gpt-5.3-codex");
  assert.equal(request.transformedBody.reasoning.effort, "high");
  assert.equal("previous_response_id" in request.transformedBody, false);
  assert.equal("temperature" in request.transformedBody, false);
  assert.equal("metadata" in request.transformedBody, false);

  const attempts = [];
  const originalBaseExecute = BaseExecutor.prototype.execute;
  const originalPrefetchImages = executor.prefetchImages.bind(executor);
  executor.prefetchImages = async () => {};
  executor.config.retry = { 503: { attempts: 1, delayMs: 0 } };
  BaseExecutor.prototype.execute = async function executeStub(args) {
    attempts.push({
      body: structuredClone(args.body),
      credentials: structuredClone(args.credentials),
    });
    return {
      response: new Response(
        attempts.length === 1
          ? 'data: {"error":{"type":"server_is_overloaded"}}\n\n'
          : "data: [DONE]\n\n",
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
      url: request.url,
      headers: request.headers,
      transformedBody: args.body,
      pathMode: null,
    };
  };

  try {
    const result = await executor.execute({
      model: "gpt-5.3-codex-high",
      stream: true,
      credentials: {
        connectionId: "conn_123",
        providerSpecificData: {
          dispatchSessionId: "dispatch_session_123",
          chatgptAccountId: "acct_123",
        },
      },
      body: request.transformedBody,
    });

    assert.equal(attempts.length, 2);
    assert.equal(attempts[1].body.prompt_cache_key, "dispatch_session_123");
    assert.equal(
      attempts[1].credentials.providerSpecificData.dispatchSessionId,
      "dispatch_session_123",
    );
    assert.equal(
      attempts[1].credentials.providerSpecificData.dispatchCompact,
      false,
    );
    assert.equal(result.headers.originator, "codex_cli_rs");
  } finally {
    BaseExecutor.prototype.execute = originalBaseExecute;
    executor.prefetchImages = originalPrefetchImages;
  }
});

test("Codex preserves structured output schema as Responses text format", () => {
  const executor = new CodexExecutor();
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      answer: { type: "string" },
    },
    required: ["answer"],
  };
  const request = executor.buildRequest({
    model: "gpt-5-codex",
    stream: true,
    credentials: {
      connectionId: "conn_schema",
      providerSpecificData: { chatgptAccountId: "acct_schema" },
    },
    body: {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "answer as json" }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "answer_schema",
          schema,
          strict: true,
        },
      },
    },
  });

  assert.deepEqual(request.transformedBody.text, {
    format: {
      type: "json_schema",
      name: "answer_schema",
      schema,
      strict: true,
    },
  });
});

test("Codex forwards unknown user request fields to upstream", () => {
  const executor = new CodexExecutor();
  const request = executor.buildRequest({
    model: "gpt-5-codex",
    stream: true,
    credentials: {
      connectionId: "conn_passthrough",
      providerSpecificData: { chatgptAccountId: "acct_passthrough" },
    },
    body: {
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "answer as json" }],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer_schema",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
          },
          strict: true,
        },
      },
      future_codex_option: { mode: "let-upstream-decide" },
    },
  });

  assert.deepEqual(request.transformedBody.response_format, {
    type: "json_schema",
    json_schema: {
      name: "answer_schema",
      schema: { type: "object", properties: { answer: { type: "string" } } },
      strict: true,
    },
  });
  assert.deepEqual(request.transformedBody.future_codex_option, {
    mode: "let-upstream-decide",
  });
});

test("OpenAI chat response_format maps to Responses text format", async () => {
  const { openaiToOpenAIResponsesRequest } =
    await import("open-sse/translator/request/openai-responses.js");
  const schema = {
    type: "object",
    properties: {
      answer: { type: "string" },
    },
    required: ["answer"],
  };

  const request = openaiToOpenAIResponsesRequest(
    "gpt-5-codex",
    {
      messages: [{ role: "user", content: "answer as json" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer_schema",
          schema,
          strict: true,
        },
      },
    },
    true,
    null,
  );

  assert.deepEqual(request.text, {
    format: {
      type: "json_schema",
      name: "answer_schema",
      schema,
      strict: true,
    },
  });
  assert.equal("response_format" in request, false);
});

test("native Codex requests convert system role to developer", () => {
  const executor = new CodexExecutor();
  const request = executor.buildRequest({
    model: "gpt-5-codex",
    stream: true,
    credentials: {
      connectionId: "conn_native",
      providerSpecificData: { chatgptAccountId: "acct_native" },
    },
    body: {
      input: [
        {
          type: "message",
          role: "system",
          content: [{ type: "input_text", text: "native rules" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "work" }],
        },
      ],
    },
  });

  assert.equal(request.transformedBody.input[0].role, "developer");
});

test("Codex SSE overload retry cancels the disturbed peek reader", async () => {
  const executor = new CodexExecutor();
  const originalBaseExecute = BaseExecutor.prototype.execute;
  const originalPrefetchImages = executor.prefetchImages.bind(executor);
  const cancelReasons = [];
  let calls = 0;

  executor.prefetchImages = async () => {};
  executor.config.retry = { 503: { attempts: 1, delayMs: 0 } };
  BaseExecutor.prototype.execute = async function executeStub(args) {
    calls += 1;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            calls === 1
              ? 'data: {"error":{"type":"server_is_overloaded"}}\\n\\n'
              : "data: [DONE]\\n\\n",
          ),
        );
        if (calls !== 1) controller.close();
      },
      cancel(reason) {
        cancelReasons.push(reason);
      },
    });
    return {
      response: new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      url: "https://codex.example.test/responses",
      headers: {},
      transformedBody: args.body,
      pathMode: null,
    };
  };

  try {
    await executor.execute({
      model: "gpt-5-codex",
      stream: true,
      credentials: { connectionId: "conn_123" },
      body: { input: "work" },
    });

    assert.equal(calls, 2);
    assert.deepEqual(cancelReasons, ["codex_sse_overloaded_retry"]);
  } finally {
    BaseExecutor.prototype.execute = originalBaseExecute;
    executor.prefetchImages = originalPrefetchImages;
  }
});

test("Codex upstream quota parser preserves precise reset timestamp", async () => {
  const executor = new CodexExecutor();
  const resetsAtSeconds = Math.floor(Date.now() / 1000) + 600;
  const response = new Response(
    JSON.stringify({
      error: {
        type: "usage_limit_reached",
        message: "Codex usage limit reached",
        resets_at: resetsAtSeconds,
      },
    }),
    { status: 429 },
  );

  const parsed = await parseUpstreamError(response, executor);
  const result = createErrorResult(
    parsed.statusCode,
    parsed.message,
    parsed.resetsAtMs,
  );

  assert.equal(parsed.statusCode, 429);
  assert.equal(parsed.message, "Codex usage limit reached");
  assert.ok(Math.abs(parsed.resetsAtMs - resetsAtSeconds * 1000) < 5);
  assert.equal(result.resetsAtMs, parsed.resetsAtMs);
});

test("generic upstream error parsing keeps provider JSON messages", async () => {
  const response = new Response(
    JSON.stringify({
      error: { message: "specific upstream failure", code: "bad_request" },
    }),
    { status: 400 },
  );

  const parsed = await parseUpstreamError(
    response,
    new DefaultExecutor("openai-compatible-local"),
  );

  assert.equal(parsed.statusCode, 400);
  assert.equal(parsed.message, "specific upstream failure");
  assert.equal(parsed.resetsAtMs, undefined);
});

test("OpenAI to Claude translator buffers and sanitizes Read tool arguments", () => {
  const state = makeClaudeState();

  const first = openaiToClaudeResponse(
    {
      id: "chatcmpl_test",
      model: "test-model",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: {
                  name: "proxy_Read",
                  arguments: '{"file_path":"notes.txt","limit":"5000",',
                },
              },
            ],
          },
        },
      ],
    },
    state,
  );
  const second = openaiToClaudeResponse(
    {
      id: "chatcmpl_test",
      model: "test-model",
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '"offset":-4,"pages":""}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    state,
  );

  assert.equal(
    first.some((event) => event.delta?.type === "input_json_delta"),
    false,
  );
  const sanitizedDelta = second.find(
    (event) => event.delta?.type === "input_json_delta",
  );
  assert.deepEqual(JSON.parse(sanitizedDelta.delta.partial_json), {
    file_path: "notes.txt",
    limit: 2000,
    offset: 0,
  });
});

test("OpenAI-compatible json_schema falls back to json_object with schema guidance", () => {
  const executor = new DefaultExecutor("openai-compatible-local");
  const transformed = executor.transformRequest("local-model", {
    messages: [{ role: "user", content: "Return status" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "Status",
        schema: {
          type: "object",
          required: ["status"],
          properties: { status: { type: "string" } },
        },
      },
    },
  });

  assert.equal(transformed.response_format.type, "json_object");
  assert.equal(transformed.messages[0].role, "system");
  assert.match(
    transformed.messages[0].content,
    /strictly follows this JSON schema/,
  );
  assert.match(transformed.messages[0].content, /"status"/);
});

test("managed dispatcher treats 35s without stream progress as idle timeout", () => {
  const now = Date.now();
  const lastProgressAt = new Date(now - 35_000).toISOString();

  assert.equal(DEFAULT_TIMEOUT_POLICY.idleTimeoutMs, 35_000);
  assert.equal(
    classifyAttemptTimeout(
      {
        queueEnteredAt: new Date(now - 40_000).toISOString(),
        leasedAt: new Date(now - 40_000).toISOString(),
        connectStartedAt: new Date(now - 38_000).toISOString(),
        streamStartedAt: new Date(now - 37_000).toISOString(),
        firstProgressAt: new Date(now - 36_000).toISOString(),
        lastProgressAt,
      },
      undefined,
      now,
    ),
    DISPATCH_TIMEOUT_KIND.IDLE_TIMEOUT,
  );
});

test("Codex token refresh deduplicates concurrent refreshes and reuses recent result", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(
      JSON.stringify({
        access_token: `access_${calls}`,
        refresh_token: `refresh_${calls}`,
        expires_in: 3600,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const [first, second] = await Promise.all([
      getAccessToken("codex", { refreshToken: "old_refresh" }),
      getAccessToken("codex", { refreshToken: "old_refresh" }),
    ]);
    const third = await getAccessToken("codex", {
      refreshToken: "old_refresh",
    });

    assert.equal(calls, 1);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("unrecoverable Codex refresh failure deactivates the connection", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { createProviderConnectionRecord, getProviderConnection } =
    await import("@/lib/sqlite/store.js");

  try {
    createProviderConnectionRecord({
      id: "conn_reused",
      provider: "codex",
      authType: "oauth",
      name: "Codex reused token",
      isActive: true,
      refreshToken: "refresh_reused",
    });

    const { checkAndRefreshToken } =
      await import("@/sse/services/tokenRefresh.js");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "refresh token reused",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );

    try {
      await checkAndRefreshToken("codex", {
        connectionId: "conn_reused",
        refreshToken: "refresh_reused",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const connection = getProviderConnection("conn_reused");
    assert.equal(connection.testStatus, "unavailable");
    assert.equal(connection.errorCode, "invalid_grant");
    assert.equal(connection.isActive, false);
  } finally {
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Codex token refresh reports unrecoverable reused refresh tokens", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        error: {
          code: "refresh_token_reused",
          message: "Refresh token was reused",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );

  try {
    const result = await refreshCodexToken("poisoned_refresh");
    assert.equal(result.error, "unrecoverable_refresh_error");
    assert.equal(result.code, "refresh_token_reused");
    assert.equal(isUnrecoverableRefreshError(result), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
