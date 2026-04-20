import test from "node:test";
import assert from "node:assert/strict";

const { CodexExecutor } = await import("../../open-sse/executors/codex.js");

test("codex executor request shaping does not leak compact mode across requests", async () => {
  const executor = new CodexExecutor();

  const first = executor.buildRequest({
    model: "gpt-5.3-codex",
    body: {
      _compact: true,
      input: [{ role: "user", content: "first" }],
    },
    credentials: {
      connectionId: "conn-1",
      providerSpecificData: {},
    },
  });

  assert.match(first.url, /\/compact$/);
  assert.equal(first.headers.session_id, "conn-1");

  const second = executor.buildRequest({
    model: "gpt-5.3-codex",
    body: {
      input: [{ role: "user", content: "second" }],
    },
    credentials: {
      connectionId: "conn-2",
      providerSpecificData: {},
    },
  });

  assert.doesNotMatch(second.url, /\/compact$/);
  assert.equal(second.headers.session_id, "conn-2");
});

test("codex executor honors explicit session and isolates per-request headers", async () => {
  const executor = new CodexExecutor();

  const requestA = executor.buildRequest({
    model: "gpt-5.3-codex",
    body: {
      input: [{ role: "user", content: "A" }],
    },
    credentials: {
      connectionId: "conn-A",
      providerSpecificData: {},
    },
    sessionId: "sess-A",
  });

  const requestB = executor.buildRequest({
    model: "gpt-5.3-codex",
    body: {
      input: [{ role: "user", content: "B" }],
    },
    credentials: {
      connectionId: "conn-B",
      providerSpecificData: {},
    },
    sessionId: "sess-B",
  });

  assert.equal(requestA.headers.session_id, "sess-A");
  assert.equal(requestB.headers.session_id, "sess-B");
  assert.notEqual(requestA.headers.session_id, requestB.headers.session_id);
});
