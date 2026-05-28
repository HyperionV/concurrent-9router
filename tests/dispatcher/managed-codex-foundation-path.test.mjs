import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CodexExecutor } from "open-sse/executors/codex.js";
import { BaseExecutor } from "open-sse/executors/base.js";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-managed-codex-"));
}

function makeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

test("managed Codex affinity session is reused as prompt cache key", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { createProviderConnectionRecord } =
    await import("@/lib/sqlite/store.js");
  const { clearDispatchTables } =
    await import("@/lib/sqlite/dispatcherStore.js");
  const { persistConversationAffinity } =
    await import("@/lib/dispatcher/conversationAffinity.js");
  const { maybeHandleManagedCodexRequest } =
    await import("@/lib/dispatcher/executeCodexAttempt.js");

  const originalBaseExecute = BaseExecutor.prototype.execute;
  const originalPrefetchImages = CodexExecutor.prototype.prefetchImages;
  const attempts = [];

  try {
    clearDispatchTables();
    createProviderConnectionRecord({
      id: "conn_affinity",
      provider: "codex",
      authType: "oauth",
      name: "Codex affinity",
      isActive: true,
      accessToken: "access_affinity",
      refreshToken: "refresh_affinity",
      providerSpecificData: { chatgptAccountId: "acct_affinity" },
    });
    persistConversationAffinity({
      conversationKey: "resp_existing",
      provider: "codex",
      modelId: "gpt-5-codex",
      connectionId: "conn_affinity",
      sessionId: "session_affinity",
      apiKeyId: "key_affinity",
    });

    CodexExecutor.prototype.prefetchImages = async () => {};
    BaseExecutor.prototype.execute = async function executeStub(args) {
      attempts.push({
        body: structuredClone(args.body),
        credentials: structuredClone(args.credentials),
      });
      return {
        response: new Response(
          JSON.stringify({ id: "resp_done", output: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        url: "https://codex.example.test/responses",
        headers: {},
        transformedBody: args.body,
        pathMode: null,
      };
    };

    const response = await maybeHandleManagedCodexRequest({
      body: {
        model: "codex/gpt-5-codex",
        previous_response_id: "resp_existing",
        messages: [{ role: "user", content: "continue" }],
        stream: false,
      },
      provider: "codex",
      model: "gpt-5-codex",
      modelStr: "codex/gpt-5-codex",
      request: new Request("https://router.test/v1/responses"),
      clientRawRequest: {
        endpoint: "/v1/responses",
        body: {},
        headers: { accept: "application/json" },
      },
      apiKey: "sk-test",
      apiKeyRecord: {
        id: "key_affinity",
        isActive: true,
        codexAdmissionPolicyOverride: "legacy",
      },
      settings: {
        dispatcherEnabled: true,
        dispatcherShadowMode: false,
        codexDefaultAdmissionPolicy: "legacy",
        dispatcherSlotsPerConnection: 1,
      },
      providerThinking: null,
      ccFilterNaming: false,
    });

    assert.equal(response.status, 200);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].body.prompt_cache_key, "session_affinity");
    assert.equal(
      attempts[0].credentials.providerSpecificData.dispatchSessionId,
      "session_affinity",
    );
  } finally {
    BaseExecutor.prototype.execute = originalBaseExecute;
    CodexExecutor.prototype.prefetchImages = originalPrefetchImages;
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed Codex credentials include token expiry for refresh preflight", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { createProviderConnectionRecord } =
    await import("@/lib/sqlite/store.js");
  const { buildManagedCredentials } =
    await import("@/lib/dispatcher/connectionState.js");

  try {
    const connection = createProviderConnectionRecord({
      id: "conn_expiry",
      provider: "codex",
      authType: "oauth",
      name: "Codex expiry",
      isActive: true,
      accessToken: "access_expiry",
      refreshToken: "refresh_expiry",
      expiresAt: "2026-05-28T12:00:00.000Z",
      expiresIn: 3600,
    });

    const credentials = await buildManagedCredentials(connection);

    assert.equal(credentials.expiresAt, "2026-05-28T12:00:00.000Z");
    assert.equal(credentials.expiresIn, 3600);
  } finally {
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("quota health tracks precise Codex reset without polling every request", async () => {
  const { createDispatcherQuotaHealth } =
    await import("@/lib/dispatcher/quotaHealth.js");
  const now = 1_000_000;
  const updates = [];
  const health = createDispatcherQuotaHealth({
    now: () => now,
    updateConnection: async (connectionId, patch) => {
      updates.push({ connectionId, patch });
    },
  });

  await health.recordOutOfQuota({
    connectionId: "conn_quota",
    modelId: "gpt-5-codex",
    resetsAtMs: now + 120_000,
    status: 429,
    error: "usage_limit_reached",
  });

  assert.equal(
    health.canServeRequest({ id: "conn_quota" }, { modelId: "gpt-5-codex" }),
    false,
  );
  assert.equal(
    health.getSelectionPenalty(
      { id: "conn_quota" },
      { modelId: "gpt-5-codex" },
    ),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    connectionId: "conn_quota",
    patch: {
      "modelLock_gpt-5-codex": new Date(now + 120_000).toISOString(),
      testStatus: "unavailable",
      lastError: "usage_limit_reached",
      errorCode: 429,
      lastErrorAt: new Date(now).toISOString(),
      providerSpecificData: {
        dispatcherQuotaHealth: {
          "gpt-5-codex": {
            status: "limited",
            remainingFraction: 0,
            checkedAt: now,
            nextCheckAt: now + 120_000,
            resetsAtMs: now + 120_000,
            source: "provider_error",
          },
        },
      },
    },
  });
});

test("quota health uses five minute normal cache and tight danger-zone polling", async () => {
  let now = 2_000_000;
  const health = (
    await import("@/lib/dispatcher/quotaHealth.js")
  ).createDispatcherQuotaHealth({ now: () => now });
  const connection = { id: "conn_cache" };
  const request = { modelId: "gpt-5-codex" };

  await health.recordQuotaSnapshot({
    connectionId: "conn_cache",
    modelId: "gpt-5-codex",
    remainingFraction: 0.4,
  });
  assert.equal(health.shouldRefreshQuota(connection, request), false);
  now += 300_001;
  assert.equal(health.shouldRefreshQuota(connection, request), true);

  await health.recordQuotaSnapshot({
    connectionId: "conn_cache",
    modelId: "gpt-5-codex",
    remainingFraction: 0.05,
  });
  assert.equal(health.shouldRefreshQuota(connection, request), false);
  now += 30_001;
  assert.equal(health.shouldRefreshQuota(connection, request), true);
});

test("quota health snapshots do not persist unless requested", async () => {
  let updateCount = 0;
  const health = (
    await import("@/lib/dispatcher/quotaHealth.js")
  ).createDispatcherQuotaHealth({
    updateConnection: async () => {
      updateCount += 1;
    },
  });

  await health.recordQuotaSnapshot({
    connectionId: "conn_poll",
    modelId: "gpt-5-codex",
    remainingFraction: 0.9,
  });

  assert.equal(updateCount, 0);
});

test("Codex OAuth backfill stores email and account claims without overwriting existing metadata", async () => {
  const tempDir = makeTempDataDir();
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { createProviderConnectionRecord, getProviderConnection } =
    await import("@/lib/sqlite/store.js");
  const { backfillCodexEmails } = await import("@/lib/oauth/providers.js");

  try {
    createProviderConnectionRecord({
      id: "conn_backfill",
      provider: "codex",
      authType: "oauth",
      name: "Codex backfill",
      isActive: true,
      idToken: makeJwt({
        email: "codex@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_from_token",
          chatgpt_plan_type: "plus",
        },
      }),
      providerSpecificData: {
        workspaceId: "workspace_existing",
        untouched: "keep-me",
      },
    });

    await backfillCodexEmails();

    const connection = getProviderConnection("conn_backfill");
    assert.equal(connection.email, "codex@example.com");
    assert.equal(
      connection.providerSpecificData.workspaceId,
      "workspace_existing",
    );
    assert.equal(
      connection.providerSpecificData.chatgptAccountId,
      "acct_from_token",
    );
    assert.equal(connection.providerSpecificData.chatgptPlanType, "plus");
    assert.equal(connection.providerSpecificData.untouched, "keep-me");
  } finally {
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
