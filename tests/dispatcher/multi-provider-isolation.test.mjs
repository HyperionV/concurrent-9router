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
    assert.notEqual(grokLease.connectionId, "codex-1");
    assert.notEqual(codexLease.connectionId, "gcli-1");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("admission is API-key only: production managed, coding legacy (all providers)", async () => {
  const {
    computeCodexAdmissionDecisionFromSettings,
    getDefaultAdmissionPolicy,
  } = await import("@/lib/dispatcher/admissionPolicy.js");

  assert.equal(
    getDefaultAdmissionPolicy({ codexDefaultAdmissionPolicy: "managed" }),
    "managed",
  );

  const productionKey = {
    id: "k-prod",
    isActive: true,
    codexAdmissionPolicyOverride: "managed",
  };
  const codingKey = {
    id: "k-coding",
    isActive: true,
    codexAdmissionPolicyOverride: "legacy",
  };

  for (const provider of ["codex", "antigravity", "grok-cli"]) {
    const managed = computeCodexAdmissionDecisionFromSettings({
      settings: { dispatcherEnabled: true },
      apiKeyRecord: productionKey,
      provider,
    });
    assert.equal(
      managed.effectiveBehavior,
      "managed",
      `${provider} production key should be managed`,
    );

    const legacy = computeCodexAdmissionDecisionFromSettings({
      settings: { dispatcherEnabled: true },
      apiKeyRecord: codingKey,
      provider,
    });
    assert.equal(
      legacy.effectiveBehavior,
      "legacy",
      `${provider} coding key should be legacy`,
    );
  }
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

test("5 concurrent tryLeaseRequest all admit under slots=15", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);
    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const { listActiveDispatchAttempts } = await import(
      "@/lib/sqlite/dispatcherStore.js"
    );

    const dispatcher = createDispatcherCore({
      provider: "codex",
      getConnections: async () => [
        { id: "conn-1", priority: 1, providerSpecificData: {} },
      ],
      getSlotsPerConnection: () => 15,
    });

    const enqueued = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        dispatcher.enqueueRequest({
          provider: "codex",
          modelId: `gpt-test-${i}`,
        }),
      ),
    );

    const leases = await Promise.all(
      enqueued.map((q) => dispatcher.tryLeaseRequest(q.request.id)),
    );

    assert.equal(
      leases.filter(Boolean).length,
      5,
      "all 5 concurrent polls must receive a lease",
    );

    const active = listActiveDispatchAttempts("codex");
    assert.equal(active.length, 5);
    for (const attempt of active) {
      assert.equal(
        attempt.state,
        "connecting",
        "lease must set connecting+connect_started_at atomically",
      );
      assert.ok(attempt.leasedAt);
      assert.ok(
        attempt.connectStartedAt,
        "connect_started_at required to avoid 30s connect_timeout ghosts",
      );
      assert.equal(attempt.connectionId, "conn-1");
    }
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("tryLeaseRequest reclaims pure-leased orphan so waiter is not stuck", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);
    const {
      insertDispatchRequest,
      insertDispatchAttempt,
      insertDispatchAttemptEvent,
      updateDispatchRequestStatus,
      getDispatchAttempt,
    } = await import("@/lib/sqlite/dispatcherStore.js");
    // Force pure-leased write (state=leased, no connect_started) to simulate
    // the 01:08 production ledger before atomic admit / lost return value.
    const { getSqlite } = await import("@/lib/sqlite/runtime.js");
    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");
    const { nowIso } = await import("@/lib/sqlite/helpers.js");
    const { randomUUID } = await import("node:crypto");

    const requestId = randomUUID();
    const attemptId = randomUUID();
    const queuedAt = nowIso();
    insertDispatchRequest({
      id: requestId,
      provider: "codex",
      modelId: "gpt-orphan",
      status: "queued",
      queuedAt,
    });
    insertDispatchAttempt({
      id: attemptId,
      requestId,
      attemptIndex: 0,
      provider: "codex",
      modelId: "gpt-orphan",
      state: "queued",
      queueEnteredAt: queuedAt,
    });

    // Simulate pre-atomic pure lease that never returned to the waiter:
    // request RUNNING + attempt LEASED + null connect_started_at.
    const db = getSqlite();
    const leasedAt = nowIso();
    db.prepare(
      `UPDATE dispatch_attempts
       SET state = 'leased',
           connection_id = @connectionId,
           lease_key = @leaseKey,
           leased_at = @leasedAt,
           connect_started_at = NULL,
           path_mode = 'direct'
       WHERE id = @attemptId AND state = 'queued'`,
    ).run({
      attemptId,
      connectionId: "conn-orphan",
      leaseKey: "conn-orphan:orphan-key",
      leasedAt,
    });
    updateDispatchRequestStatus(requestId, "running");
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType: "leased",
      payload: { connectionId: "conn-orphan" },
    });

    const orphan = getDispatchAttempt(attemptId);
    assert.equal(orphan.state, "leased");
    assert.equal(orphan.connectStartedAt, null);

    const dispatcher = createDispatcherCore({
      provider: "codex",
      getConnections: async () => [
        { id: "conn-orphan", priority: 1, providerSpecificData: {} },
      ],
      getSlotsPerConnection: () => 8,
    });

    // listQueued no longer contains this request — old tryLease returned null.
    const lease = await dispatcher.tryLeaseRequest(requestId);
    assert.ok(lease, "must reclaim orphan leased attempt for the waiter");
    assert.equal(lease.attemptId, attemptId);
    assert.equal(lease.connectionId, "conn-orphan");
    assert.equal(lease.reclaimed, true);
    assert.equal(lease.attempt.state, "connecting");
    assert.ok(
      lease.attempt.connectStartedAt,
      "reclaim must heal connect_started_at so connect_timeout cannot fire",
    );
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("zombie leased attempts from a dead process block capacity until reconciled", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);

    const {
      insertDispatchRequest,
      insertDispatchAttempt,
      listActiveDispatchAttempts,
      transitionDispatchAttempt,
      updateDispatchRequestStatus,
    } = await import("@/lib/sqlite/dispatcherStore.js");
    const { createDispatcherCore } = await import("@/lib/dispatcher/core.js");

    // Crashed process left a leased row that still counts toward occupancy.
    const request = insertDispatchRequest({
      id: "req-zombie-1",
      provider: "codex",
      modelId: "gpt-zombie",
      status: "running",
      queuedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    insertDispatchAttempt({
      id: "att-zombie-1",
      requestId: request.id,
      attemptIndex: 0,
      provider: "codex",
      modelId: "gpt-zombie",
      connectionId: "conn-1",
      leaseKey: "conn-1:dead",
      state: "leased",
      queueEnteredAt: new Date(Date.now() - 60_000).toISOString(),
      leasedAt: new Date(Date.now() - 55_000).toISOString(),
    });
    assert.equal(listActiveDispatchAttempts("codex").length, 1);

    const dispatcher = createDispatcherCore({
      provider: "codex",
      getConnections: async () => [
        { id: "conn-1", priority: 1, providerSpecificData: {} },
      ],
      getSlotsPerConnection: () => 1,
    });

    const queued = await dispatcher.enqueueRequest({
      provider: "codex",
      modelId: "gpt-live",
    });
    const blocked = await dispatcher.tryLeaseRequest(queued.request.id);
    assert.equal(
      blocked,
      null,
      "1-slot pool must stay full while zombie lease is active",
    );

    // Process-start reconcile closes zombies so capacity returns.
    transitionDispatchAttempt(
      "att-zombie-1",
      ["queued", "leased", "connecting", "streaming"],
      "reconciled",
      {
        finishedAt: new Date().toISOString(),
        terminalReason: "reconciled",
        error: { code: "process_restart" },
      },
    );
    updateDispatchRequestStatus(request.id, "cancelled", {
      completedAt: new Date().toISOString(),
    });
    assert.equal(listActiveDispatchAttempts("codex").length, 0);

    const lease = await dispatcher.tryLeaseRequest(queued.request.id);
    assert.ok(lease, "lease must succeed after zombie is reconciled");
    assert.equal(lease.connectionId, "conn-1");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("slots per connection are isolated per provider (no shared fallback)", async () => {
  const {
    getDispatcherSlotsPerConnection,
    normalizeDispatcherSlotsByProvider,
    patchDispatcherSlotsForProvider,
  } = await import("@/lib/dispatcher/settings.js");

  // Raising codex must not raise antigravity / grok-cli.
  const afterCodex = patchDispatcherSlotsForProvider(
    {
      dispatcherSlotsByProvider: {
        codex: 1,
        antigravity: 1,
        "grok-cli": 1,
      },
      dispatcherSlotsPerConnection: 1,
    },
    "codex",
    15,
  );
  assert.equal(afterCodex.dispatcherSlotsByProvider.codex, 15);
  assert.equal(afterCodex.dispatcherSlotsByProvider.antigravity, 1);
  assert.equal(afterCodex.dispatcherSlotsByProvider["grok-cli"], 1);
  assert.equal(afterCodex.dispatcherSlotsPerConnection, 15);

  assert.equal(getDispatcherSlotsPerConnection(afterCodex, "codex"), 15);
  assert.equal(getDispatcherSlotsPerConnection(afterCodex, "antigravity"), 1);
  assert.equal(getDispatcherSlotsPerConnection(afterCodex, "grok-cli"), 1);

  // Raising grok-cli must not change codex.
  const afterGrok = patchDispatcherSlotsForProvider(afterCodex, "grok-cli", 7);
  assert.equal(afterGrok.dispatcherSlotsByProvider.codex, 15);
  assert.equal(afterGrok.dispatcherSlotsByProvider["grok-cli"], 7);
  assert.equal(afterGrok.dispatcherSlotsByProvider.antigravity, 1);

  // Empty map seeds codex from legacy column only — other providers stay 1.
  const fromLegacy = normalizeDispatcherSlotsByProvider({}, 12);
  assert.equal(fromLegacy.codex, 12);
  assert.equal(fromLegacy.antigravity, 1);
  assert.equal(fromLegacy["grok-cli"], 1);

  // Missing map entries must not inherit another provider's slots.
  assert.equal(
    getDispatcherSlotsPerConnection(
      {
        dispatcherSlotsPerConnection: 20,
        dispatcherSlotsByProvider: { codex: 20 },
      },
      "antigravity",
    ),
    1,
  );
});

test("persisted settings keep per-provider slots isolated", async () => {
  const tempDir = makeTempDataDir();

  try {
    process.env.DATA_DIR = tempDir;
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();

    const { writeSettings, readSettings } = await import(
      "@/lib/sqlite/store.js"
    );

    writeSettings({
      dispatcherSlotsByProvider: {
        codex: 15,
        antigravity: 3,
        "grok-cli": 8,
      },
    });

    const loaded = readSettings();
    assert.equal(loaded.dispatcherSlotsByProvider.codex, 15);
    assert.equal(loaded.dispatcherSlotsByProvider.antigravity, 3);
    assert.equal(loaded.dispatcherSlotsByProvider["grok-cli"], 8);
    assert.equal(loaded.dispatcherSlotsPerConnection, 15);

    // Partial update of one provider must not clobber others.
    writeSettings({
      dispatcherSlotsByProvider: {
        ...loaded.dispatcherSlotsByProvider,
        antigravity: 4,
      },
    });
    const again = readSettings();
    assert.equal(again.dispatcherSlotsByProvider.codex, 15);
    assert.equal(again.dispatcherSlotsByProvider.antigravity, 4);
    assert.equal(again.dispatcherSlotsByProvider["grok-cli"], 8);
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

test("poll lease path acquires second slot after completeAttempt", async () => {
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

    const lease1 = await dispatcher.tryLeaseRequest(first.request.id);
    assert.ok(lease1);
    assert.equal(
      await dispatcher.tryLeaseRequest(second.request.id),
      null,
      "second must wait while slot is full",
    );

    await dispatcher.completeAttempt(lease1.attemptId);
    const lease2 = await dispatcher.tryLeaseRequest(second.request.id);
    assert.ok(lease2, "second request should lease after first completes");
    assert.equal(lease2.connectionId, "conn-1");
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
