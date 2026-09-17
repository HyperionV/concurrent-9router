/**
 * Grok CLI chat-proxy identity headers.
 *
 * cli-chat-proxy.grok.com OAuth path must send the official CLI User-Agent
 * (xai-grok-workspace/<version>) alongside X-XAI-Token-Auth and
 * x-grok-client-version. Direct api.x.ai / custom-gateway paths must stay
 * free of that CLI fingerprint.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDERS,
  GROK_CLI_CLIENT_VERSION,
  GROK_CLI_USER_AGENT,
  GROK_CLI_TOKEN_AUTH,
  GROK_CLI_IDENTITY_HEADERS,
} from "../config/providers.js";
import {
  GrokCliExecutor,
  resolveGrokCliAgentId,
  _resetGrokCliAgentStore,
} from "./grok-cli.js";
import { DefaultExecutor } from "./default.js";
import { BaseExecutor } from "./base.js";

test("grok-cli registry pins official CLI identity at 0.2.101", () => {
  const cfg = PROVIDERS["grok-cli"];
  assert.equal(GROK_CLI_CLIENT_VERSION, "0.2.101");
  assert.equal(cfg.clientVersion, "0.2.101");
  assert.equal(cfg.tokenAuth, GROK_CLI_TOKEN_AUTH);
  assert.equal(cfg.headers["User-Agent"], "xai-grok-workspace/0.2.101");
  assert.equal(cfg.headers["x-grok-client-version"], "0.2.101");
  assert.equal(cfg.headers["x-xai-token-auth"], "xai-grok-cli");
  assert.equal(GROK_CLI_USER_AGENT, "xai-grok-workspace/0.2.101");
  assert.equal(
    GROK_CLI_IDENTITY_HEADERS["User-Agent"],
    "xai-grok-workspace/0.2.101",
  );
});

test("GrokCliExecutor buildHeaders sends CLI User-Agent with token-auth", () => {
  const executor = new GrokCliExecutor();
  executor._currentSessionId = "sess-1";
  executor._currentReqId = "req-1";
  executor._currentTurnIdx = 1;
  executor._currentModel = "grok-4.5";

  const headers = executor.buildHeaders(
    {
      accessToken: "tok_oauth",
      providerSpecificData: { email: "u@example.com", userId: "uid-1" },
    },
    true,
  );

  assert.equal(headers["User-Agent"], "xai-grok-workspace/0.2.101");
  assert.equal(headers["x-xai-token-auth"], "xai-grok-cli");
  assert.equal(headers["x-grok-client-version"], "0.2.101");
  assert.equal(headers["x-grok-client-identifier"], "grok-pager");
  assert.equal(headers.Authorization, "Bearer tok_oauth");
  assert.equal(headers["x-email"], "u@example.com");
  assert.equal(headers["x-userid"], "uid-1");
});

test("direct xai API-key path does not get CLI chat-proxy identity headers", () => {
  const xai = PROVIDERS.xai;
  assert.ok(xai, "xai provider registered");
  assert.equal(xai.baseUrl, "https://api.x.ai/v1/chat/completions");
  assert.equal(xai.headers?.["User-Agent"], undefined);
  assert.equal(xai.headers?.["x-xai-token-auth"], undefined);
  assert.equal(xai.headers?.["x-grok-client-version"], undefined);

  const executor = new DefaultExecutor("xai");
  const headers = executor.buildHeaders({ apiKey: "xai-key-test" }, true);

  assert.equal(headers.Authorization, "Bearer xai-key-test");
  assert.notEqual(headers["User-Agent"], "xai-grok-workspace/0.2.101");
  assert.equal(headers["x-xai-token-auth"], undefined);
  assert.equal(headers["x-grok-client-version"], undefined);
});

test("custom openai-compatible gateway path stays free of Grok CLI fingerprint", () => {
  const custom = {
    baseUrl: "https://gateway.example.com/v1/chat/completions",
    format: "openai",
    headers: { "X-Title": "custom-gateway" },
  };
  const executor = new BaseExecutor("openai-compatible-custom", custom);
  const headers = executor.buildHeaders({ apiKey: "gw-key" }, false);

  assert.equal(headers.Authorization, "Bearer gw-key");
  assert.equal(headers["X-Title"], "custom-gateway");
  assert.equal(headers["User-Agent"], undefined);
  assert.equal(headers["x-xai-token-auth"], undefined);
  assert.equal(headers["x-grok-client-version"], undefined);
});

test("Grok CLI deviceId rotation: rotates across different sessions/requests and respects pinned deviceId", () => {
  _resetGrokCliAgentStore();

  // Case 1: unpinned connection without session generates unique random UUIDs
  const id1 = resolveGrokCliAgentId(null, {});
  const id2 = resolveGrokCliAgentId(null, {});
  assert.match(id1, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(id2, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.notEqual(id1, id2, "Independent requests get distinct random deviceIds");

  // Case 2: same session retains stable deviceId across turns
  const sessA_turn1 = resolveGrokCliAgentId("sess-alpha", {});
  const sessA_turn2 = resolveGrokCliAgentId("sess-alpha", {});
  const sessB_turn1 = resolveGrokCliAgentId("sess-beta", {});
  assert.equal(sessA_turn1, sessA_turn2, "Same session reuses deviceId across turns");
  assert.notEqual(sessA_turn1, sessB_turn1, "Different sessions get distinct deviceIds");

  // Case 3: pinned deviceId without rotation is respected
  const pinned = resolveGrokCliAgentId("sess-pinned", { deviceId: "custom-device-123" });
  assert.equal(pinned, "custom-device-123");

  // Case 4: forced rotation overrides pinned deviceId
  const rotated = resolveGrokCliAgentId("sess-pinned", {
    deviceId: "custom-device-123",
    rotateDeviceId: true,
  });
  assert.notEqual(rotated, "custom-device-123");
  assert.match(rotated, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

test("GrokCliExecutor buildHeaders includes rotated x-grok-agent-id header", () => {
  const executor = new GrokCliExecutor();
  const headers1 = executor.buildHeaders({ accessToken: "tok1", providerSpecificData: {} }, true);
  const headers2 = executor.buildHeaders({ accessToken: "tok2", providerSpecificData: {} }, true);

  assert.ok(headers1["x-grok-agent-id"]);
  assert.ok(headers2["x-grok-agent-id"]);
  assert.match(headers1["x-grok-agent-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.match(headers2["x-grok-agent-id"], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

