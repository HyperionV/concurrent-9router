import test from "node:test";
import assert from "node:assert/strict";

import { parseCodexAuthJson } from "@/lib/oauth/codexAuthJson.js";

const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");

function makeJwt(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("parses Codex auth.json tokens into provider connection data", () => {
  const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3600;
  const accessToken = makeJwt({
    exp: expiresAtSeconds,
    "https://api.openai.com/profile": {
      email: "operator@example.com",
      email_verified: true,
    },
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "plus",
    },
  });
  const idToken = makeJwt({
    email: "fallback@example.com",
    name: "Fallback User",
  });

  const parsed = parseCodexAuthJson(
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: accessToken,
        refresh_token: "rt_test_refresh",
        id_token: idToken,
        account_id: "acct_payload",
      },
      last_refresh: "2026-05-28T08:28:25.034Z",
    }),
  );

  assert.equal(parsed.provider, "codex");
  assert.equal(parsed.authType, "oauth");
  assert.equal(parsed.accessToken, accessToken);
  assert.equal(parsed.refreshToken, "rt_test_refresh");
  assert.equal(parsed.idToken, idToken);
  assert.equal(parsed.email, "operator@example.com");
  assert.equal(parsed.expiresAt, new Date(expiresAtSeconds * 1000).toISOString());
  assert.deepEqual(parsed.providerSpecificData, {
    accountId: "acct_123",
    authMethod: "auth-json-import",
    authMode: "chatgpt",
    planType: "plus",
    lastRefresh: "2026-05-28T08:28:25.034Z",
  });
});

test("rejects invalid Codex auth.json without logging token content", () => {
  assert.throws(
    () => parseCodexAuthJson(JSON.stringify({ tokens: { refresh_token: "rt_only" } })),
    /Codex auth.json is missing tokens.access_token/,
  );

  assert.throws(
    () => parseCodexAuthJson("not json"),
    /Invalid JSON/,
  );
});
