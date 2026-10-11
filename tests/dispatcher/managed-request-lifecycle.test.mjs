import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexExecutor } from "open-sse/executors/codex.js";
import { BaseExecutor } from "open-sse/executors/base.js";

const MANAGED_SETTINGS = {
  dispatcherEnabled: true,
  dispatcherShadowMode: false,
  codexDefaultAdmissionPolicy: "managed",
  dispatcherSlotsPerConnection: 1,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function upstreamResult(response, args) {
  return {
    response,
    url: "https://codex.example.test/responses",
    headers: {},
    transformedBody: args.body,
    pathMode: null,
  };
}

/**
 * Real dispatcher + real SQLite; only the upstream HTTP call is stubbed.
 * `respond(args, callIndex)` returns the raw upstream Response.
 */
async function withManagedCodex(connectionIds, respond, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-lifecycle-"));
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { createProviderConnectionRecord, deleteProviderConnectionsForProvider } =
    await import("@/lib/sqlite/store.js");
  const { clearDispatchTables, getLatestDispatchAttemptForRequest, listActiveDispatchAttempts } =
    await import("@/lib/sqlite/dispatcherStore.js");
  const { invalidateDispatcherConnectionCache, getProviderDispatcher } =
    await import("@/lib/dispatcher/index.js");
  const { maybeHandleManagedCodexRequest } = await import(
    "@/lib/dispatcher/executeCodexAttempt.js"
  );

  const originalExecute = BaseExecutor.prototype.execute;
  const originalPrefetch = CodexExecutor.prototype.prefetchImages;
  const calls = [];

  try {
    // DATA_DIR is fixed per process, so every test in this file shares one DB.
    clearDispatchTables();
    deleteProviderConnectionsForProvider("codex");
    connectionIds.forEach((id, index) => {
      createProviderConnectionRecord({
        id,
        provider: "codex",
        authType: "oauth",
        name: `Codex ${id}`,
        isActive: true,
        priority: index + 1,
        accessToken: `access_${id}`,
        refreshToken: `refresh_${id}`,
        // Far from expiry so the router never calls the real token endpoint.
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        providerSpecificData: { chatgptAccountId: `acct_${id}` },
      });
    });
    invalidateDispatcherConnectionCache?.("codex");

    CodexExecutor.prototype.prefetchImages = async () => {};
    BaseExecutor.prototype.execute = async function executeStub(args) {
      const index = calls.length;
      calls.push({ connectionId: args.credentials?.connectionId, signal: args.signal });
      return upstreamResult(await respond(args, index), args);
    };

    const send = ({ signal, body = {} } = {}) =>
      maybeHandleManagedCodexRequest({
        body: {
          model: "codex/gpt-5-codex",
          messages: [{ role: "user", content: "hello" }],
          stream: false,
          ...body,
        },
        provider: "codex",
        model: "gpt-5-codex",
        modelStr: "codex/gpt-5-codex",
        request: new Request("https://router.test/v1/chat/completions", {
          method: "POST",
          signal,
        }),
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: {},
          headers: { accept: "application/json" },
        },
        apiKey: "sk-test",
        apiKeyRecord: { id: "key_test", isActive: true },
        settings: MANAGED_SETTINGS,
        providerThinking: null,
        ccFilterNaming: false,
      });

    await run({
      send,
      calls,
      dispatcher: getProviderDispatcher("codex").dispatcher,
      getLatestDispatchAttemptForRequest,
      listActiveDispatchAttempts,
    });
  } finally {
    BaseExecutor.prototype.execute = originalExecute;
    CodexExecutor.prototype.prefetchImages = originalPrefetch;
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("a queued request whose client disconnects is cancelled and never reaches upstream", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["conn_a"],
    () => jsonResponse(200, { id: "resp_ok", output: [] }),
    async ({ send, calls, dispatcher, listActiveDispatchAttempts }) => {
      // Occupy the only slot so the next request has to queue.
      const blocker = await dispatcher.enqueueRequest({
        provider: "codex",
        modelId: "gpt-5-codex",
      });
      const blockerLease = await dispatcher.tryLeaseRequest(blocker.request.id);
      assert.ok(blockerLease, "blocker should hold the only slot");

      const client = new AbortController();
      const pending = send({ signal: client.signal });
      await sleep(150);
      client.abort();

      const startedAt = Date.now();
      const response = await pending;
      assert.ok(Date.now() - startedAt < 1000, "cancel must end the wait promptly");
      assert.equal(response.status, 499);

      // Free the slot: the cancelled request must not be admitted afterwards.
      await dispatcher.completeAttempt(blockerLease.attemptId);
      await sleep(300);
      assert.equal(calls.length, 0, "upstream must never be called");
      assert.equal(
        listActiveDispatchAttempts("codex").length,
        0,
        "no attempt may hold a slot",
      );
    },
  );
});

test("an upstream stream that breaks mid-way releases the slot immediately", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["conn_a"],
    () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
            ),
          );
          setTimeout(() => {
            const error = new Error("socket hang up");
            error.code = "ECONNRESET";
            controller.error(error);
          }, 50);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
    async ({ send, listActiveDispatchAttempts }) => {
      const response = await send({ body: { stream: true } });
      // Drain what the client receives; the break must not throw at the client.
      await response.text().catch(() => {});
      await sleep(100);
      assert.equal(
        listActiveDispatchAttempts("codex").length,
        0,
        "broken stream must not keep holding the slot",
      );
    },
  );
});

test("failover keeps trying other accounts until one serves the request", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["conn_a", "conn_b", "conn_c"],
    (args, index) =>
      index < 2
        ? jsonResponse(429, { error: { message: "Rate limit reached" } })
        : jsonResponse(200, { id: "resp_ok", output: [] }),
    async ({ send, calls }) => {
      const response = await send();
      assert.equal(response.status, 200);
      assert.equal(calls.length, 3);
      assert.equal(new Set(calls.map((c) => c.connectionId)).size, 3);
    },
  );
});

test("when no other account remains, the failure returns without another queue wait", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["conn_a"],
    () => jsonResponse(429, { error: { message: "Rate limit reached" } }),
    async ({ send, calls }) => {
      const startedAt = Date.now();
      const response = await send();
      assert.ok(Date.now() - startedAt < 2000, "must not wait for a lease that cannot exist");
      assert.equal(response.status, 429);
      assert.equal(calls.length, 1);
    },
  );
});

test("a burst of clients that give up early leaves no ghost work upstream", async () => {
  const UPSTREAM_MS = 300;
  const CLIENT_GIVES_UP_MS = 500;
  await withManagedCodex(
    ["conn_a", "conn_b", "conn_c"],
    async (args) => {
      await sleep(UPSTREAM_MS);
      if (args.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return jsonResponse(200, { id: "resp_ok", output: [] });
    },
    async ({ send, calls, listActiveDispatchAttempts }) => {
      // 20 clients on 3 single-slot accounts, each giving up after 500 ms.
      const results = await Promise.all(
        Array.from({ length: 20 }, () => {
          const client = new AbortController();
          setTimeout(() => client.abort(), CLIENT_GIVES_UP_MS);
          return send({ signal: client.signal });
        }),
      );
      await sleep(UPSTREAM_MS * 3);

      // Only requests that got a slot before their client left reached upstream:
      // two rounds of three, not twenty.
      assert.ok(calls.length <= 6, `upstream saw ${calls.length} calls`);
      assert.equal(results.filter((r) => r.status === 499).length >= 14, true);
      assert.equal(listActiveDispatchAttempts("codex").length, 0);
    },
  );
});
