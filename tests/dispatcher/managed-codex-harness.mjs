// Shared harness for tests that drive a real managed Codex request through the
// real dispatcher and real SQLite. Only the upstream HTTP call is stubbed, at
// the executor's network boundary. Not a test file (no .test.mjs suffix).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexExecutor } from "open-sse/executors/codex.js";
import { BaseExecutor } from "open-sse/executors/base.js";

export const MANAGED_SETTINGS = {
  dispatcherEnabled: true,
  dispatcherShadowMode: false,
  codexDefaultAdmissionPolicy: "managed",
  dispatcherSlotsPerConnection: 1,
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ALL_ATTEMPT_STATES = [
  "queued",
  "leased",
  "connecting",
  "streaming",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "reconciled",
];

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
 * `respond(args, callIndex)` returns the raw upstream Response for each call.
 * `calls` records which account each upstream call was made for, and the
 * session id the router attached to it.
 */
export async function withManagedCodex(connectionIds, respond, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "router-lifecycle-"));
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { createProviderConnectionRecord, deleteProviderConnectionsForProvider } =
    await import("@/lib/sqlite/store.js");
  const dispatcherStore = await import("@/lib/sqlite/dispatcherStore.js");
  const { getProviderConnectionById } = await import("@/lib/localDb.js");
  const { invalidateDispatcherConnectionCache, getProviderDispatcher } =
    await import("@/lib/dispatcher/index.js");
  const { maybeHandleManagedCodexRequest } = await import(
    "@/lib/dispatcher/executeCodexAttempt.js"
  );

  const originalExecute = BaseExecutor.prototype.execute;
  const originalPrefetch = CodexExecutor.prototype.prefetchImages;
  const calls = [];

  try {
    // DATA_DIR is fixed per process, so every test in a file shares one DB.
    dispatcherStore.clearDispatchTables();
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
        // Far from expiry so the router does not refresh before the first call.
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        providerSpecificData: { chatgptAccountId: `acct_${id}` },
      });
    });
    invalidateDispatcherConnectionCache?.("codex");

    CodexExecutor.prototype.prefetchImages = async () => {};
    BaseExecutor.prototype.execute = async function executeStub(args) {
      const index = calls.length;
      calls.push({
        connectionId: args.credentials?.connectionId,
        accessToken: args.credentials?.accessToken,
        sessionId: args.credentials?.providerSpecificData?.dispatchSessionId || null,
        signal: args.signal,
      });
      return upstreamResult(await respond(args, index), args);
    };

    const send = ({ signal, body = {}, headers = {} } = {}) =>
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
          headers: { accept: "application/json", ...headers },
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
      invalidateConnections: () => invalidateDispatcherConnectionCache?.("codex"),
      getConnection: getProviderConnectionById,
      listActiveDispatchAttempts: dispatcherStore.listActiveDispatchAttempts,
      getLatestDispatchAttemptForRequest: dispatcherStore.getLatestDispatchAttemptForRequest,
      getConversationAffinity: (conversationKey) =>
        dispatcherStore.getDispatchConversationAffinity(
          conversationKey,
          "key_test",
          "codex",
        ),
      seedConversationAffinity: (record) =>
        dispatcherStore.upsertDispatchConversationAffinity({
          apiKeyScope: "key_test",
          provider: "codex",
          modelId: "gpt-5-codex",
          apiKeyId: "key_test",
          state: "active",
          ...record,
        }),
      listAttempts: () =>
        dispatcherStore.listDispatchAttemptsByState(ALL_ATTEMPT_STATES, "codex"),
    });
  } finally {
    BaseExecutor.prototype.execute = originalExecute;
    CodexExecutor.prototype.prefetchImages = originalPrefetch;
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
