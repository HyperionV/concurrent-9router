import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-multi-provider-"));
}

async function resetDispatcherTables(tempDir) {
  process.env.DATA_DIR = tempDir;
  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { clearDispatchTables } =
    await import("@/lib/sqlite/dispatcherStore.js");
  clearDispatchTables();
}

test("text dispatcher pools isolate codex from grok-cli leases", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");

    const codexConnections = [
      { id: "codex-1", priority: 1, providerSpecificData: {} },
    ];
    const grokConnections = [
      { id: "gcli-1", priority: 1, providerSpecificData: {} },
    ];

    const codexDispatcher = createDispatcherCore({
      provider: "codex",
      getConnections: async () => codexConnections,
      getSlotsPerConnection: () => 1,
    });
    const grokDispatcher = createDispatcherCore({
      provider: "grok-cli",
      getConnections: async () => grokConnections,
      getSlotsPerConnection: () => 1,
    });

    const codexQueued = await codexDispatcher.enqueueRequest({
      provider: "codex",
      modelId: "gpt-5-codex",
    });
    const grokQueued = await grokDispatcher.enqueueRequest({
      provider: "grok-cli",
      modelId: "grok-4.5",
    });

    const codexLease = await codexDispatcher.tryLeaseRequest(
      codexQueued.request.id,
    );
    const grokLease = await grokDispatcher.tryLeaseRequest(
      grokQueued.request.id,
    );

    assert.ok(codexLease, "codex should lease");
    assert.ok(grokLease, "grok should lease");
    assert.equal(codexLease.connectionId, "codex-1");
    assert.equal(grokLease.connectionId, "gcli-1");

    // Grok queue must not hand out a Codex connection
    assert.notEqual(grokLease.connectionId, "codex-1");
    assert.notEqual(codexLease.connectionId, "gcli-1");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("antigravity and grok-cli default admission policy is legacy", async () => {
  const {
    computeCodexAdmissionDecisionFromSettings,
    getDefaultAdmissionPolicyForProvider,
  } = await import("@/lib/dispatcher/admissionPolicy.js");

  assert.equal(
    getDefaultAdmissionPolicyForProvider({}, "antigravity"),
    "legacy",
  );
  assert.equal(getDefaultAdmissionPolicyForProvider({}, "grok-cli"), "legacy");
  assert.equal(
    getDefaultAdmissionPolicyForProvider(
      { codexDefaultAdmissionPolicy: "managed" },
      "codex",
    ),
    "managed",
  );

  const decision = computeCodexAdmissionDecisionFromSettings({
    settings: {
      dispatcherEnabled: true,
      providerAdmissionPolicies: {},
    },
    provider: "grok-cli",
  });
  assert.equal(decision.effectiveBehavior, "legacy");

  const managedGrok = computeCodexAdmissionDecisionFromSettings({
    settings: {
      dispatcherEnabled: true,
      providerAdmissionPolicies: { "grok-cli": "managed" },
    },
    provider: "grok-cli",
  });
  assert.equal(managedGrok.effectiveBehavior, "managed");
});

test("TEXT_DISPATCH_PROVIDERS includes codex, antigravity, grok-cli", async () => {
  const { TEXT_DISPATCH_PROVIDERS } = await import(
    "@/lib/dispatcher/settings.js"
  );
  assert.deepEqual(
    [...TEXT_DISPATCH_PROVIDERS].sort(),
    ["antigravity", "codex", "grok-cli"].sort(),
  );
});

test("specialized executors registered for antigravity and grok-cli", async () => {
  const { getExecutor, hasSpecializedExecutor } = await import(
    "open-sse/executors/index.js"
  );
  assert.equal(hasSpecializedExecutor("codex"), true);
  assert.equal(hasSpecializedExecutor("antigravity"), true);
  assert.equal(hasSpecializedExecutor("grok-cli"), true);
  assert.equal(hasSpecializedExecutor("gcli"), true);
  assert.equal(getExecutor("antigravity").provider, "antigravity");
  assert.equal(getExecutor("grok-cli").provider, "grok-cli");
  assert.equal(getExecutor("gb").provider, "grok-cli");
});

test("evented lease waiters wake after completeAttempt", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);
    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");

    const dispatcher = createDispatcherCore({
      provider: "codex",
      getConnections: async () => [
        { id: "conn-1", priority: 1, providerSpecificData: {} },
      ],
      getSlotsPerConnection: () => 1,
    });

    const first = await dispatcher.enqueueRequest({
      provider: "codex",
      modelId: "gpt-5-codex",
    });
    const second = await dispatcher.enqueueRequest({
      provider: "codex",
      modelId: "gpt-5-codex",
    });

    const lease1 = await dispatcher.waitForAssignedLease(first.request.id, 2000);
    assert.ok(lease1);

    dispatcher.resetLeaseMetrics?.();
    const waitPromise = dispatcher.waitForAssignedLease(
      second.request.id,
      2000,
    );
    // Complete first attempt → central refill assigns second without tryLeaseRequest poll
    await dispatcher.completeAttempt(lease1.attemptId);
    const lease2 = await waitPromise;
    assert.ok(lease2, "second request should lease after first completes");
    assert.equal(lease2.connectionId, "conn-1");

    const metrics = dispatcher.getLeaseMetrics?.() || {};
    // Under true evented refill, waiters should not drive tryLeaseRequest
    assert.equal(
      metrics.tryLeaseRequestCount ?? 0,
      0,
      "waitForAssignedLease must not poll tryLeaseRequest",
    );
    assert.ok(
      (metrics.tryLeaseAvailableWorkCount ?? 0) >= 1,
      "refill should call tryLeaseAvailableWork",
    );
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
