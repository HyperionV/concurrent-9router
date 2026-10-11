import test from "node:test";
import assert from "node:assert/strict";

// Which upstream errors are the account's fault. Real account store on the
// test's own SQLite database; each test uses its own account id.

async function freshAccount(id) {
  const { createProviderConnectionRecord } = await import("@/lib/sqlite/store.js");
  createProviderConnectionRecord({
    id,
    provider: "codex",
    authType: "oauth",
    name: `Codex ${id}`,
    isActive: true,
    priority: 1,
    accessToken: `access_${id}`,
    refreshToken: `refresh_${id}`,
    expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    providerSpecificData: { chatgptAccountId: `acct_${id}` },
  });
  const { markAccountUnavailable } = await import("@/sse/services/auth.js");
  const { getProviderConnectionById } = await import("@/lib/localDb.js");
  return {
    fail: (status, errorText) =>
      markAccountUnavailable(id, status, errorText, "codex", "gpt-5-codex"),
    read: () => getProviderConnectionById(id),
  };
}

for (const status of [400, 404, 413, 422]) {
  test(`a ${status} is the request's problem: no failover and the account stays healthy`, async () => {
    const account = await freshAccount(`conn_client_${status}`);

    const { shouldFallback } = await account.fail(status, "Invalid schema for response_format");

    assert.equal(shouldFallback, false);
    const after = await account.read();
    assert.equal(after.isActive, true);
    assert.ok(!after.lastError, "the account must not record the request's error");
    assert.ok(
      !Object.keys(after).some((key) => key.startsWith("modelLock_")),
      "the account must not be locked",
    );
  });
}

test("a 403 that is not an auth failure (an HTML challenge page) cools the account but keeps it active", async () => {
  const account = await freshAccount("conn_html_403");

  const { shouldFallback } = await account.fail(403, "Just a moment...");

  assert.equal(shouldFallback, true);
  const after = await account.read();
  assert.equal(after.isActive, true);
  assert.ok(Object.keys(after).some((key) => key.startsWith("modelLock_")));
});

test("a 401 saying the token was invalidated deactivates the account", async () => {
  const account = await freshAccount("conn_revoked_401");

  await account.fail(
    401,
    "Your authentication token has been invalidated. Please try signing in again.",
  );

  assert.equal((await account.read()).isActive, false);
});

test("only an exhausted usage allowance counts as a usage limit, not a passing rate limit", async () => {
  const { isUsageLimitError } = await import("@/lib/connectionHealth.js");

  assert.equal(
    isUsageLimitError("You've used all the included free usage for model grok-4.6 for now"),
    true,
  );
  assert.equal(isUsageLimitError('{"error":{"type":"usage_limit_reached"}}'), true);
  assert.equal(isUsageLimitError("Rate limit reached for requests. Please try again in 1s."), false);
  assert.equal(isUsageLimitError("rate_limit_exceeded"), false);
});

test("an image request that hits a rate limit marks the account once, not twice", async () => {
  const account = await freshAccount("conn_image_429");
  const { handleImageGeneration } = await import("@/sse/handlers/imageGeneration.js");
  const { invalidateDispatcherConnectionCache } = await import("@/lib/dispatcher/index.js");
  invalidateDispatcherConnectionCache?.("codex");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Rate limit reached" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const response = await handleImageGeneration(
      new Request("http://localhost/api/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-connection-id": "conn_image_429" },
        body: JSON.stringify({ model: "cx/gpt-5.4-image", prompt: "draw a router" }),
      }),
    );

    assert.equal(response.status, 429);
    assert.equal((await account.read()).backoffLevel, 1, "one failure is one backoff step");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function fakeJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

// What the import route does with the pasted accounts (the route module
// itself needs the Next.js runtime).
async function importCodexAccounts(accounts) {
  const { parseCodexBatch } = await import("@/lib/oauth/codexAuthJson.js");
  const { createProviderConnection } = await import("@/lib/localDb.js");
  const parsed = parseCodexBatch(accounts);
  for (const account of parsed.accounts) {
    await createProviderConnection({ ...account, testStatus: "active" });
  }
  return parsed;
}

test("re-importing an older auth.json keeps the tokens the router already rotated, and the account's settings", async () => {
  const { createProviderConnectionRecord } = await import("@/lib/sqlite/store.js");
  const { getProviderConnectionById } = await import("@/lib/localDb.js");
  const now = Math.floor(Date.now() / 1000);
  createProviderConnectionRecord({
    id: "conn_reimport",
    provider: "codex",
    authType: "oauth",
    email: "analyst@example.com",
    isActive: true,
    accessToken: fakeJwt({ email: "analyst@example.com", exp: now + 10 * 86_400 }),
    refreshToken: "refresh_rotated_by_router",
    expiresAt: new Date((now + 10 * 86_400) * 1000).toISOString(),
    providerSpecificData: { chatgptAccountId: "acct_1", proxyPoolId: "pool_eu" },
  });

  const imported = await importCodexAccounts([
    {
      email: "analyst@example.com",
      access_token: fakeJwt({ email: "analyst@example.com", exp: now + 2 * 86_400 }),
      refresh_token: "refresh_from_old_export",
      chatgpt_account_id: "acct_1",
    },
  ]);

  assert.equal(imported.accounts.length, 1);
  const account = await getProviderConnectionById("conn_reimport");
  assert.equal(account.refreshToken, "refresh_rotated_by_router");
  assert.equal(account.providerSpecificData.proxyPoolId, "pool_eu");
});

test("re-importing a newer auth.json replaces the tokens of the same account", async () => {
  const { createProviderConnectionRecord, listProviderConnections } = await import(
    "@/lib/sqlite/store.js"
  );
  const now = Math.floor(Date.now() / 1000);
  createProviderConnectionRecord({
    id: "conn_reimport_newer",
    provider: "codex",
    authType: "oauth",
    email: "lead@example.com",
    isActive: true,
    accessToken: fakeJwt({ email: "lead@example.com", exp: now + 86_400 }),
    refreshToken: "refresh_old",
    expiresAt: new Date((now + 86_400) * 1000).toISOString(),
    providerSpecificData: { chatgptAccountId: "acct_2" },
  });

  await importCodexAccounts([
    {
      email: "Lead@Example.com",
      access_token: fakeJwt({ email: "lead@example.com", exp: now + 9 * 86_400 }),
      refresh_token: "refresh_new",
      chatgpt_account_id: "acct_2",
    },
  ]);

  const matches = listProviderConnections({ provider: "codex" }).filter(
    (connection) => connection.email?.toLowerCase() === "lead@example.com",
  );
  assert.equal(matches.length, 1, "the same account must not be imported twice");
  assert.equal(matches[0].refreshToken, "refresh_new");
});

test("recording a usage limit keeps the account's stored settings and other models' limits, and saves no conversation session", async () => {
  const { createProviderConnectionRecord } = await import("@/lib/sqlite/store.js");
  const { getProviderConnectionById } = await import("@/lib/localDb.js");
  const { createDispatcherQuotaHealth } = await import("@/lib/dispatcher/quotaHealth.js");
  createProviderConnectionRecord({
    id: "conn_quota_merge",
    provider: "codex",
    authType: "oauth",
    email: "quota@example.com",
    isActive: true,
    accessToken: "access",
    refreshToken: "refresh",
    providerSpecificData: { chatgptAccountId: "acct_q", proxyPoolId: "pool_eu" },
  });
  const quotaHealth = createDispatcherQuotaHealth({ memory: new Map() });

  // What a request holds: an older copy of the settings plus its conversation's session.
  const requestCopy = { chatgptAccountId: "acct_q", dispatchSessionId: "sess_one_conversation" };
  await quotaHealth.recordOutOfQuota({ connectionId: "conn_quota_merge", modelId: "gpt-5-codex", providerSpecificData: requestCopy });
  await quotaHealth.recordOutOfQuota({ connectionId: "conn_quota_merge", modelId: "gpt-5-mini", providerSpecificData: requestCopy });

  const stored = (await getProviderConnectionById("conn_quota_merge")).providerSpecificData;
  assert.equal(stored.proxyPoolId, "pool_eu");
  assert.equal(stored.dispatchSessionId, undefined);
  assert.ok(stored.dispatcherQuotaHealth["gpt-5-codex"], "the first model's limit survives the second write");
  assert.ok(stored.dispatcherQuotaHealth["gpt-5-mini"]);
});
