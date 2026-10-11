import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexExecutor } from "open-sse/executors/codex.js";
import { BaseExecutor } from "open-sse/executors/base.js";

// How the router reports an upstream reply that failed, was cut short, or never
// finished. Real dispatcher, real chatCore and translators, real SQLite; only
// the upstream HTTP response is stubbed, with raw Codex Responses SSE.

const MANAGED_SETTINGS = {
  dispatcherEnabled: true,
  dispatcherShadowMode: false,
  codexDefaultAdmissionPolicy: "managed",
  dispatcherSlotsPerConnection: 1,
};

const FINISHED_STATES = ["completed", "failed", "cancelled", "timed_out"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

const CREATED = sseEvent("response.created", {
  response: { id: "resp_1", status: "in_progress" },
});
const PARTIAL_TEXT = sseEvent("response.output_text.delta", { delta: "Partial answer" });
const FAILED = sseEvent("response.failed", {
  response: {
    id: "resp_1",
    status: "failed",
    error: { code: "server_error", message: "The model crashed" },
  },
});
const UPSTREAM_USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 40 },
  output_tokens: 50,
  output_tokens_details: { reasoning_tokens: 10 },
  total_tokens: 150,
};
const INCOMPLETE = sseEvent("response.incomplete", {
  response: {
    id: "resp_1",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    usage: UPSTREAM_USAGE,
  },
});
const MESSAGE_DONE = sseEvent("response.output_item.done", {
  output_index: 0,
  item: {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "Partial answer" }],
  },
});
const COMPLETED = sseEvent("response.completed", {
  response: { id: "resp_1", status: "completed", usage: UPSTREAM_USAGE },
});

function sseResponse(...events) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function chatDataChunks(text) {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6)));
}

async function withManagedCodex(connectionId, upstreamResponse, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-truthful-"));
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { createProviderConnectionRecord, deleteProviderConnectionsForProvider } =
    await import("@/lib/sqlite/store.js");
  const { clearDispatchTables, listActiveDispatchAttempts, listDispatchAttemptsByState } =
    await import("@/lib/sqlite/dispatcherStore.js");
  const { invalidateDispatcherConnectionCache } = await import("@/lib/dispatcher/index.js");
  const { getProviderConnectionById } = await import("@/lib/localDb.js");
  const { maybeHandleManagedCodexRequest } = await import(
    "@/lib/dispatcher/executeCodexAttempt.js"
  );

  const originalExecute = BaseExecutor.prototype.execute;
  const originalPrefetch = CodexExecutor.prototype.prefetchImages;

  try {
    clearDispatchTables();
    deleteProviderConnectionsForProvider("codex");
    createProviderConnectionRecord({
      id: connectionId,
      provider: "codex",
      authType: "oauth",
      name: `Codex ${connectionId}`,
      isActive: true,
      priority: 1,
      accessToken: `access_${connectionId}`,
      refreshToken: `refresh_${connectionId}`,
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      // An error left by an earlier request: only a finished reply may clear it.
      testStatus: "unavailable",
      lastError: "earlier upstream failure",
      providerSpecificData: { chatgptAccountId: `acct_${connectionId}` },
    });
    invalidateDispatcherConnectionCache?.("codex");

    CodexExecutor.prototype.prefetchImages = async () => {};
    BaseExecutor.prototype.execute = async function executeStub(args) {
      return {
        response: upstreamResponse(),
        url: "https://codex.example.test/responses",
        headers: {},
        transformedBody: args.body,
        pathMode: null,
      };
    };

    const send = ({ stream, endpoint = "/v1/chat/completions" }) => {
      const body =
        endpoint === "/v1/responses"
          ? { model: "codex/gpt-5-codex", input: "hello", stream }
          : {
              model: "codex/gpt-5-codex",
              messages: [{ role: "user", content: "hello" }],
              stream,
            };
      return maybeHandleManagedCodexRequest({
        body,
        provider: "codex",
        model: "gpt-5-codex",
        modelStr: "codex/gpt-5-codex",
        request: new Request(`https://router.test${endpoint}`, { method: "POST" }),
        clientRawRequest: {
          endpoint,
          body: {},
          headers: { accept: stream ? "text/event-stream" : "application/json" },
        },
        apiKey: "sk-test",
        apiKeyRecord: { id: "key_test", isActive: true },
        settings: MANAGED_SETTINGS,
        providerThinking: null,
        ccFilterNaming: false,
      });
    };

    const settle = async () => {
      // Stream callbacks finish just after the client reads the last byte.
      await sleep(100);
      return {
        activeAttempts: listActiveDispatchAttempts("codex").length,
        lastAttempt: listDispatchAttemptsByState(FINISHED_STATES, "codex").at(-1),
        account: await getProviderConnectionById(connectionId),
      };
    };

    await run({ send, settle });
  } finally {
    BaseExecutor.prototype.execute = originalExecute;
    CodexExecutor.prototype.prefetchImages = originalPrefetch;
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("a streaming chat client sees an error, not text, when the upstream reply fails", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    "conn_stream_failed",
    () => sseResponse(CREATED, PARTIAL_TEXT, FAILED),
    async ({ send, settle }) => {
      const text = await (await send({ stream: true })).text();
      const chunks = chatDataChunks(text);

      assert.ok(!text.includes("[Error]"), "the failure must not be sent as answer text");
      const errorChunk = chunks.find((chunk) => chunk.error);
      assert.equal(errorChunk?.error?.message, "The model crashed");
      assert.ok(
        !chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop"),
        "a failed reply must not finish as stop",
      );

      const { activeAttempts, lastAttempt, account } = await settle();
      assert.equal(activeAttempts, 0);
      assert.equal(lastAttempt.state, "failed");
      assert.equal(account.lastError, "earlier upstream failure", "a failure must not clear the account error");
    },
  );
});

test("a streaming chat reply cut off at the output limit finishes with length and the upstream usage", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    "conn_stream_incomplete",
    () => sseResponse(CREATED, PARTIAL_TEXT, INCOMPLETE),
    async ({ send }) => {
      const chunks = chatDataChunks(await (await send({ stream: true })).text());
      const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason);

      assert.equal(finish.choices[0].finish_reason, "length");
      assert.equal(finish.usage.prompt_tokens, 100);
      assert.equal(finish.usage.completion_tokens, 50);
      assert.equal(finish.usage.prompt_tokens_details.cached_tokens, 40);
      assert.equal(finish.usage.completion_tokens_details.reasoning_tokens, 10);
    },
  );
});

test("a streaming chat reply whose upstream connection ends early is reported as an error", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    "conn_stream_truncated",
    () => sseResponse(CREATED, PARTIAL_TEXT),
    async ({ send, settle }) => {
      const chunks = chatDataChunks(await (await send({ stream: true })).text());

      assert.ok(chunks.some((chunk) => chunk.error), "an unfinished reply must end with an error");
      assert.ok(!chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === "stop"));
      assert.equal((await settle()).lastAttempt.state, "failed");
    },
  );
});

test("a finished streaming reply reports the exact upstream usage and clears the account error", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    "conn_stream_completed",
    () => sseResponse(CREATED, PARTIAL_TEXT, MESSAGE_DONE, COMPLETED),
    async ({ send, settle }) => {
      const chunks = chatDataChunks(await (await send({ stream: true })).text());
      const finish = chunks.find((chunk) => chunk.choices?.[0]?.finish_reason);

      assert.equal(finish.choices[0].finish_reason, "stop");
      assert.equal(finish.usage.prompt_tokens, 100, "usage must not be inflated");
      assert.equal(finish.usage.total_tokens, 150);

      const { lastAttempt, account } = await settle();
      assert.equal(lastAttempt.state, "completed");
      assert.ok(!account.lastError, "a finished reply clears the earlier error");
    },
  );
});

test("a non-streaming chat client gets a gateway error, not a 200, when the upstream reply fails", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    "conn_json_failed",
    () => sseResponse(CREATED, PARTIAL_TEXT, FAILED),
    async ({ send, settle }) => {
      const response = await send({ stream: false });
      const payload = await response.json();

      assert.equal(response.status, 502);
      assert.match(payload.error.message, /The model crashed/);
      assert.equal(payload.choices, undefined);

      const { activeAttempts, lastAttempt } = await settle();
      assert.equal(activeAttempts, 0);
      assert.equal(lastAttempt.state, "failed");
    },
  );
});

test("a non-streaming chat reply cut off at the output limit returns length with the upstream usage", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    "conn_json_incomplete",
    () => sseResponse(CREATED, PARTIAL_TEXT, MESSAGE_DONE, INCOMPLETE),
    async ({ send }) => {
      const response = await send({ stream: false });
      const payload = await response.json();

      assert.equal(response.status, 200);
      assert.equal(payload.choices[0].finish_reason, "length");
      assert.equal(payload.choices[0].message.content, "Partial answer");
      assert.equal(payload.usage.prompt_tokens, 100);
      assert.equal(payload.usage.prompt_tokens_details.cached_tokens, 40);
    },
  );
});

test("a non-streaming chat reply whose upstream connection ends early is a gateway error", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    "conn_json_truncated",
    () => sseResponse(CREATED, PARTIAL_TEXT),
    async ({ send }) => {
      const response = await send({ stream: false });
      assert.equal(response.status, 502);
      assert.ok((await response.json()).error);
    },
  );
});

test("a Responses client is told the stream failed when upstream ends early, even if the text mentions a finish event", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    "conn_responses_truncated",
    () =>
      sseResponse(
        CREATED,
        sseEvent("response.output_text.delta", { delta: "it emits response.done when finished" }),
      ),
    async ({ send, settle }) => {
      const text = await (await send({ stream: true, endpoint: "/v1/responses" })).text();

      assert.match(text, /event: response\.failed/);
      assert.equal((await settle()).lastAttempt.state, "failed");
    },
  );
});
