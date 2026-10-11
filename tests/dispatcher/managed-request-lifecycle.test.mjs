import test from "node:test";
import assert from "node:assert/strict";

import { jsonResponse, sleep, withManagedCodex } from "./managed-codex-harness.mjs";

test("a queued request whose client disconnects is cancelled and never reaches upstream", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["conn_a"],
    () => jsonResponse(200, { id: "resp_ok", output: [] }),
    async ({ send, calls, dispatcher, listActiveDispatchAttempts, listAttempts }) => {
      // Occupy the only slot so the next request has to queue.
      const blocker = await dispatcher.enqueueRequest({
        provider: "codex",
        modelId: "gpt-5-codex",
      });
      const blockerLease = await dispatcher.tryLeaseRequest(blocker.request.id);
      assert.ok(blockerLease, "blocker should hold the only slot");

      const client = new AbortController();
      const pending = send({ signal: client.signal });
      await sleep(150);
      client.abort();

      const startedAt = Date.now();
      const response = await pending;
      assert.ok(Date.now() - startedAt < 1000, "cancel must end the wait promptly");
      assert.equal(response.status, 499);
      const cancelled = listAttempts().filter((attempt) => attempt.state === "cancelled");
      assert.equal(cancelled.length, 1);
      assert.equal(cancelled[0].terminalReason, "client_disconnected");

      // Free the slot: the cancelled request must not be admitted afterwards.
      await dispatcher.completeAttempt(blockerLease.attemptId);
      await sleep(300);
      assert.equal(calls.length, 0, "upstream must never be called");
      assert.equal(
        listActiveDispatchAttempts("codex").length,
        0,
        "no attempt may hold a slot",
      );
    },
  );
});

test("failover keeps trying other accounts until one serves the request", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["conn_a", "conn_b", "conn_c"],
    (args, index) =>
      index < 2
        ? jsonResponse(429, { error: { message: "Rate limit reached" } })
        : jsonResponse(200, { id: "resp_ok", output: [] }),
    async ({ send, calls }) => {
      const response = await send();
      assert.equal(response.status, 200);
      assert.equal(calls.length, 3);
      assert.equal(new Set(calls.map((c) => c.connectionId)).size, 3);
    },
  );
});

test("when no other account remains, the failure returns without another queue wait", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["conn_a"],
    () => jsonResponse(429, { error: { message: "Rate limit reached" } }),
    async ({ send, calls }) => {
      const startedAt = Date.now();
      const response = await send();
      assert.ok(Date.now() - startedAt < 2000, "must not wait for a lease that cannot exist");
      assert.equal(response.status, 429);
      assert.equal(calls.length, 1);
    },
  );
});

// Account ids are unique per test: quota health remembers 429s per account id
// in process memory.
test("when every account answers 429 the request ends after trying each account once", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["conn_all429_a", "conn_all429_b", "conn_all429_c"],
    () => jsonResponse(429, { error: { message: "Rate limit reached" } }),
    async ({ send, calls }) => {
      const response = await send();
      assert.equal(response.status, 429);
      assert.equal(calls.length, 3);
      assert.equal(new Set(calls.map((c) => c.connectionId)).size, 3);
    },
  );
});

test("a client that leaves mid-request does not put a healthy account into cooldown", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["conn_leaver"],
    (args, index) =>
      index === 0
        ? new Promise((_, reject) => {
            args.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          })
        : jsonResponse(200, { id: "resp_ok", output: [] }),
    async ({ send, calls, listActiveDispatchAttempts }) => {
      const client = new AbortController();
      const pending = send({ signal: client.signal });
      await sleep(200);
      client.abort();
      const abandoned = await pending;
      assert.equal(abandoned.status, 499);
      assert.equal(listActiveDispatchAttempts("codex").length, 0);

      // The only account must serve the next request straight away.
      const startedAt = Date.now();
      const next = await send();
      assert.equal(next.status, 200);
      assert.ok(Date.now() - startedAt < 2000, "account must not be cooling down");
      assert.equal(calls.length, 2);
    },
  );
});

test("a burst of clients that give up early leaves no ghost work upstream", async () => {
  const UPSTREAM_MS = 300;
  const CLIENT_GIVES_UP_MS = 500;
  await withManagedCodex(
    ["conn_a", "conn_b", "conn_c"],
    async (args) => {
      await sleep(UPSTREAM_MS);
      if (args.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return jsonResponse(200, { id: "resp_ok", output: [] });
    },
    async ({ send, calls, listActiveDispatchAttempts }) => {
      // 20 clients on 3 single-slot accounts, each giving up after 500 ms.
      const results = await Promise.all(
        Array.from({ length: 20 }, () => {
          const client = new AbortController();
          setTimeout(() => client.abort(), CLIENT_GIVES_UP_MS);
          return send({ signal: client.signal });
        }),
      );
      await sleep(UPSTREAM_MS * 3);

      // Only requests that got a slot before their client left reached upstream:
      // two rounds of three, not twenty.
      assert.ok(calls.length <= 6, `upstream saw ${calls.length} calls`);
      assert.equal(results.filter((r) => r.status === 499).length >= 14, true);
      assert.equal(listActiveDispatchAttempts("codex").length, 0);
    },
  );
});
