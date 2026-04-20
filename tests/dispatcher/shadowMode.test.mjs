import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-shadow-"));
process.env.DATA_DIR = tempRoot;

const runtime = await import("../../src/lib/sqlite/runtime.js");
const store = await import("../../src/lib/sqlite/dispatcherStore.js");
const { beginShadowCodexAttempt } =
  await import("../../src/lib/dispatcher/shadowMode.js");

test("shadow mode records lifecycle without enforcing dispatcher admission", async () => {
  runtime.getSqlite();
  store.clearDispatchTables();

  const tracker = beginShadowCodexAttempt({
    provider: "codex",
    modelId: "gpt-5.4-low",
    routeModel: "cx/gpt-5.4-low",
    sourceEndpoint: "/v1/responses",
    sourceFormat: "openai-responses",
    targetFormat: "openai-responses",
    connectionId: "conn-12",
    pathMode: "connection-proxy",
    sessionId: "sess-12",
  });

  let request = store.getDispatchRequest(tracker.requestId);
  let attempt = store.getDispatchAttempt(tracker.attemptId);

  assert.equal(request.status, "running");
  assert.equal(request.metadata.executionMode, "shadow");
  assert.equal(attempt.state, "leased");
  assert.equal(attempt.connectionId, "conn-12");

  await tracker.dispatcherHooks.onConnectStarted({
    pathMode: "connection-proxy",
  });
  await tracker.dispatcherHooks.onStreamStarted();
  await tracker.dispatcherHooks.onFirstProgress();
  await tracker.dispatcherHooks.onResponseIdentity("resp-shadow-1");
  await tracker.finalizeSuccess("success");

  request = store.getDispatchRequest(tracker.requestId);
  attempt = store.getDispatchAttempt(tracker.attemptId);

  assert.equal(request.status, "completed");
  assert.equal(attempt.state, "completed");
  assert.equal(attempt.pathMode, "connection-proxy");
  assert.equal(
    store.getDispatchConversationAffinity("resp-shadow-1")?.connectionId,
    "conn-12",
  );
  assert.equal(
    store
      .listDispatchAttemptEvents(tracker.attemptId)
      .some((event) => event.eventType === "completed"),
    true,
  );
});
