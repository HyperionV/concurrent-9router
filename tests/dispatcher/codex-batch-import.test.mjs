import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCodexAccountItem, parseCodexAuthJson, parseCodexBatch } from "../../src/lib/oauth/codexAuthJson.js";

test("parseCodexAuthJson handles standard single auth.json", () => {
  const sampleAuthJson = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: "header.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20iLCJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjLTEyMyJ9LCJleHAiOjE4MDAwMDAwMDB9.sig",
      refresh_token: "rt.1.test_refresh_token",
      id_token: "header.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.sig"
    }
  });

  const parsed = parseCodexAuthJson(sampleAuthJson);
  assert.equal(parsed.provider, "codex");
  assert.equal(parsed.authType, "oauth");
  assert.equal(parsed.email, "test@example.com");
  assert.equal(parsed.providerSpecificData.accountId, "acc-123");
  assert.equal(parsed.refreshToken, "rt.1.test_refresh_token");
});

test("parseCodexAccountItem handles flat account order export format", () => {
  const item = {
    phone: "5451953165",
    email: "matthewwaltonkr40199qgk@outlook.com",
    chatgpt_account_id: "a5409490-4575-4d18-a44e-96b1d31b9c74",
    access_token: "header.eyJzdWIiOiJhdXRoMHwxMjMiLCJodHRwczovL2FwaS5vcGVuYWkuY29tL3Byb2ZpbGUiOnsiZW1haWwiOiJNYXR0aGV3V2FsdG9ua3I0MDE5OXFnS0BvdXRsb29rLmNvbSJ9LCJleHAiOjE3OTA4MjgzNjN9.sig",
    refresh_token: "rt.1.sample_refresh",
    id_token: "header.eyJlbWFpbCI6Ik1hdHRoZXdXYWx0b25rcjQwMTk5cWdLQG91dGxvb2suY29tIn0.sig",
    oai_did: "d5ec0755-7716-4e79-81f0-c47d9af02510",
    impersonate: "chrome145",
    expires_in: 864000
  };

  const parsed = parseCodexAccountItem(item);
  assert.equal(parsed.provider, "codex");
  assert.equal(parsed.email, "matthewwaltonkr40199qgk@outlook.com");
  assert.equal(parsed.providerSpecificData.accountId, "a5409490-4575-4d18-a44e-96b1d31b9c74");
  assert.equal(parsed.providerSpecificData.oaiDid, "d5ec0755-7716-4e79-81f0-c47d9af02510");
  assert.equal(parsed.providerSpecificData.phone, "5451953165");
  assert.equal(parsed.providerSpecificData.impersonate, "chrome145");
  assert.ok(parsed.expiresAt);
});

test("parseCodexBatch parses array of accounts from live order export if available or simulated array", () => {
  const liveFilePath = "E:\\Download\\chatgpt-free-codex-order-762368-5-accounts.json";
  let content;
  if (fs.existsSync(liveFilePath)) {
    content = fs.readFileSync(liveFilePath, "utf8");
  } else {
    content = JSON.stringify([
      {
        email: "acc1@test.com",
        access_token: "h.eyJlbWFpbCI6ImFjYzFAdGVzdC5jb20iLCJleHAiOjE4MDAwMDAwMDB9.s",
        refresh_token: "rt.1.acc1",
        chatgpt_account_id: "id-1"
      },
      {
        email: "acc2@test.com",
        access_token: "h.eyJlbWFpbCI6ImFjYzJAdGVzdC5jb20iLCJleHAiOjE4MDAwMDAwMDB9.s",
        refresh_token: "rt.1.acc2",
        chatgpt_account_id: "id-2"
      }
    ]);
  }

  const result = parseCodexBatch(content);
  assert.ok(result.accounts.length >= 2, "Should parse accounts in batch");
  assert.equal(result.errors.length, 0, "Should have no errors on valid payload");
  for (const acc of result.accounts) {
    assert.equal(acc.provider, "codex");
    assert.ok(acc.accessToken);
    assert.ok(acc.refreshToken);
    assert.ok(acc.email);
  }
});

test("parseCodexBatch isolates faulty items without cascading failure", () => {
  const mixedBatch = [
    {
      email: "valid@test.com",
      access_token: "h.eyJlbWFpbCI6InZhbGlkQHRlc3QuY29tIn0.s",
      refresh_token: "rt.1.valid"
    },
    {
      // Missing refresh_token
      email: "invalid@test.com",
      access_token: "h.eyJlbWFpbCI6ImludmFsaWRAdGVzdC5jb20ifQ.s"
    },
    {
      email: "valid2@test.com",
      access_token: "h.eyJlbWFpbCI6InZhbGlkMkB0ZXN0LmNvbSJ9.s",
      refresh_token: "rt.1.valid2"
    }
  ];

  const result = parseCodexBatch(mixedBatch);
  assert.equal(result.accounts.length, 2, "Should parse 2 valid accounts");
  assert.equal(result.errors.length, 1, "Should capture 1 error envelope");
  assert.match(result.errors[0], /Missing refresh_token/);
});

test("parseCodexBatch supports wrapped objects like { accounts: [...] }", () => {
  const wrapped = {
    accounts: [
      {
        email: "wrap@test.com",
        access_token: "h.eyJlbWFpbCI6IndyYXBGdGVzdC5jb20ifQ.s",
        refresh_token: "rt.1.wrap"
      }
    ]
  };

  const result = parseCodexBatch(wrapped);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].email, "wrap@test.com");
});
