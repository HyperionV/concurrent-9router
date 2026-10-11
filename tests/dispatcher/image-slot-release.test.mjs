import test from "node:test";
import assert from "node:assert/strict";

test("a hung image upstream is cut off at the deadline and reported as a failure", async () => {
  const { handleImageGenerationCore } = await import(
    "open-sse/handlers/imageGenerationCore.js"
  );
  const originalFetch = globalThis.fetch;
  const failures = [];
  // The router's deadline timer is unref'd (a live server keeps the loop busy);
  // hold the loop open here the way a running server would.
  const keepAlive = setInterval(() => {}, 1000);

  // Upstream accepts the connection and then never answers.
  globalThis.fetch = (url, init) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });

  try {
    const startedAt = Date.now();
    const result = await handleImageGenerationCore({
      body: { prompt: "a lighthouse at dusk" },
      modelInfo: { provider: "codex", model: "gpt-5.5-image" },
      credentials: { accessToken: "token", providerSpecificData: {} },
      upstreamTimeoutMs: 200,
      dispatcherHooks: {
        onFailure: async (failure) => failures.push(failure),
      },
    });

    assert.ok(Date.now() - startedAt < 2000, "must not wait past the deadline");
    assert.equal(result.success, false);
    assert.equal(result.status, 504);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = originalFetch;
  }
});

test("process start clears image attempts left active by a previous process", async () => {
  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const {
    clearImageDispatchTables,
    insertImageDispatchRequest,
    insertImageDispatchAttempt,
    leaseImageDispatchAttempt,
    getImageDispatchAttempt,
  } = await import("@/lib/sqlite/imageDispatcherStore.js");
  const { clearZombieAttemptsOnProcessBoot } = await import(
    "@/lib/dispatcher/processBootClean.js"
  );

  clearImageDispatchTables();
  const request = insertImageDispatchRequest({
    id: "img_req_1",
    provider: "codex",
    modelId: "gpt-5.5-image",
    status: "running",
  });
  const attempt = insertImageDispatchAttempt({
    id: "img_att_1",
    requestId: request.id,
    attemptIndex: 0,
    provider: "codex",
    modelId: "gpt-5.5-image",
    state: "queued",
  });
  leaseImageDispatchAttempt(attempt.id, {
    connectionId: "conn_img",
    leaseKey: "conn_img:lease",
    leasedAt: new Date().toISOString(),
  });

  // A new process instance runs the boot clean.
  process.env.DISPATCHER_INSTANCE_ID = `test-${Date.now()}`;
  clearZombieAttemptsOnProcessBoot();

  assert.equal(getImageDispatchAttempt(attempt.id).state, "reconciled");
});
