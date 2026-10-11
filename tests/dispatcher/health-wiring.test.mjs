import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The usage endpoint reaches its upstreams through globalThis.fetch. Install
// the stub before the route is imported so the proxy layer captures it.
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const upstreamBodies = new Map();
globalThis.fetch = async (url) => {
  const key = String(url);
  const matched = [...upstreamBodies.keys()].find((prefix) =>
    key.startsWith(prefix),
  );
  if (!matched) return new Response("not found", { status: 404 });
  return new Response(JSON.stringify(upstreamBodies.get(matched)), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-health-wiring-"));
}

async function openCleanDatabase() {
  process.env.DATA_DIR = makeTempDataDir();
  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { clearDispatchTables } =
    await import("@/lib/sqlite/dispatcherStore.js");
  clearDispatchTables();
}

function createOauthConnection(createProviderConnectionRecord, provider, id) {
  return createProviderConnectionRecord({
    id,
    provider,
    authType: "oauth",
    name: id,
    isActive: true,
    accessToken: `access_${id}`,
    refreshToken: `refresh_${id}`,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    providerSpecificData: { lastRefreshAt: new Date().toISOString() },
  });
}

async function pollUsage(connectionId) {
  const { GET } = await import("@/app/api/usage/[connectionId]/route.js");
  const response = await GET(
    new Request(`https://router.test/api/usage/${connectionId}`),
    { params: Promise.resolve({ connectionId }) },
  );
  assert.equal(response.status, 200);
  return response.json();
}

async function leaseOneRequest({ provider, connections, modelId }) {
  const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
  const dispatcher = createDispatcherCore({
    provider,
    getConnections: async () => connections,
    getSlotsPerConnection: () => 1,
  });
  const queued = await dispatcher.enqueueRequest({ modelId });
  return dispatcher.tryLeaseRequest(queued.request.id);
}

async function assertUsagePollSteersAccountChoice({
  provider,
  modelId,
  upstream,
}) {
  await openCleanDatabase();
  const { createProviderConnectionRecord } =
    await import("@/lib/sqlite/store.js");
  const drained = createOauthConnection(
    createProviderConnectionRecord,
    provider,
    `${provider}_drained`,
  );
  const fresh = createOauthConnection(
    createProviderConnectionRecord,
    provider,
    `${provider}_fresh`,
  );
  const connections = [drained, fresh].map((connection) => ({
    id: connection.id,
    priority: connection.priority,
    providerSpecificData: {},
  }));
  assert.ok(drained.priority < fresh.priority);

  const before = await leaseOneRequest({ provider, connections, modelId });
  assert.equal(
    before.connectionId,
    drained.id,
    "without quota data the higher-priority account wins",
  );

  const { dispatcherQuotaHealth } =
    await import("@/lib/dispatcher/quotaHealth.js");
  upstream(97);
  await pollUsage(drained.id);
  upstream(20);
  await pollUsage(fresh.id);

  assert.equal(
    dispatcherQuotaHealth.getSelectionPenalty(drained, { modelId }) > 0,
    true,
  );
  assert.equal(
    dispatcherQuotaHealth.getSelectionPenalty(fresh, { modelId }),
    0,
  );

  const { clearDispatchTables } =
    await import("@/lib/sqlite/dispatcherStore.js");
  clearDispatchTables();
  const after = await leaseOneRequest({ provider, connections, modelId });
  assert.equal(
    after.connectionId,
    fresh.id,
    "after the usage poll the nearly drained account is passed over",
  );
}

test("a Codex usage poll tells the dispatcher which account is nearly out of quota", async () => {
  await assertUsagePollSteersAccountChoice({
    provider: "codex",
    modelId: "gpt-5-codex",
    upstream: (usedPercent) => {
      upstreamBodies.set(CODEX_USAGE_URL, {
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: usedPercent },
          secondary_window: { used_percent: 10 },
        },
      });
    },
  });
});

test("a Grok CLI usage poll tells the dispatcher which account is nearly out of quota", async () => {
  await assertUsagePollSteersAccountChoice({
    provider: "grok-cli",
    modelId: "grok-build",
    upstream: (usedPercent) => {
      upstreamBodies.set(GROK_BILLING_URL, {
        config: {
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
          creditUsagePercent: usedPercent,
        },
      });
    },
  });
});

test("finished attempts move the score of the path they ran on", async () => {
  await openCleanDatabase();
  const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
  const relayed = {
    id: "conn-relayed",
    priority: 1,
    providerSpecificData: { vercelRelayUrl: "https://relay.example.test" },
  };
  const direct = {
    id: "conn-direct",
    priority: 2,
    providerSpecificData: {},
  };
  const dispatcher = createDispatcherCore({
    getConnections: async () => [relayed],
    getSlotsPerConnection: () => 1,
  });
  const score = () =>
    dispatcher.pathHealth.getPathScore(relayed.id, "vercel-relay");

  const first = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
  const firstLease = await dispatcher.tryLeaseRequest(first.request.id);
  assert.equal(firstLease.pathMode, "vercel-relay");
  await dispatcher.failAttempt(firstLease.attemptId, {
    nextState: "timed_out",
    terminalReason: "timeout",
    timeoutKind: "connect_timeout",
  });
  assert.equal(score(), 40, "a connect timeout costs the path 60 points");

  const second = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
  const secondLease = await dispatcher.tryLeaseRequest(second.request.id);
  await dispatcher.completeAttempt(secondLease.attemptId);
  assert.equal(score(), 50, "a completed attempt gives 10 points back");

  assert.ok(
    dispatcher.pathHealth.rankConnection(relayed) <
      dispatcher.pathHealth.rankConnection(direct),
    "the connection ranking reads the same path the outcomes were recorded on",
  );

  const third = await dispatcher.enqueueRequest({ modelId: "gpt-5-codex" });
  const thirdLease = await dispatcher.tryLeaseRequest(third.request.id);
  await dispatcher.failAttempt(thirdLease.attemptId, {
    nextState: "cancelled",
    terminalReason: "client_disconnected",
  });
  assert.equal(score(), 50, "a client leaving says nothing about the path");
});
