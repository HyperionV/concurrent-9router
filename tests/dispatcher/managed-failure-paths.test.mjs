/**
 * Failure paths of a managed Codex request, end to end through the real
 * dispatcher and SQLite ledger. Only the upstream HTTP responses are stubbed.
 *
 * Every test uses its own account ids: upstream 429s are remembered
 * process-wide per account id, so reusing ids would leak between tests.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { OAUTH_ENDPOINTS } from "open-sse/config/appConstants.js";
import { jsonResponse, sleep, withManagedCodex } from "./managed-codex-harness.mjs";

const NO_HANG_MS = 3000;

const SSE_CREATED =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1"}}\n\n';
const SSE_DELTA =
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n';
const SSE_COMPLETED =
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}\n\n';

/** An upstream SSE body that delivers `chunks`, then resets the connection (or ends cleanly). */
function sseResponse(chunks, { thenReset }) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      setTimeout(() => {
        if (thenReset) {
          controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
        } else {
          controller.close();
        }
      }, 50);
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const brokenStream = () => sseResponse([SSE_CREATED, SSE_DELTA], { thenReset: true });
const healthyStream = () =>
  sseResponse([SSE_CREATED, SSE_DELTA, SSE_COMPLETED], { thenReset: false });

/** An upstream call that stays open until the router aborts it. */
function hangUntilAborted(args) {
  return new Promise((_, reject) => {
    args.signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
  });
}

async function readWithoutHanging(response) {
  const text = await Promise.race([
    response.text(),
    sleep(NO_HANG_MS).then(() => "__HUNG__"),
  ]);
  assert.notEqual(text, "__HUNG__", "the client must not be left waiting on a broken stream");
  return text;
}

function assertNoSlotHeld({ listActiveDispatchAttempts, dispatcher }, connectionIds) {
  assert.equal(listActiveDispatchAttempts("codex").length, 0);
  const occupancy = dispatcher.getInMemorySnapshot().occupancyByConnection;
  for (const id of connectionIds) assert.equal(occupancy[id] || 0, 0, `${id} still holds a slot`);
}

/** Answers the OAuth token endpoint like the provider does; everything else passes through. */
function stubTokenEndpoint() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    String(url) === OAUTH_ENDPOINTS.openai.token
      ? jsonResponse(200, {
          access_token: "refreshed_access_token",
          refresh_token: "refreshed_refresh_token",
          expires_in: 3600,
        })
      : originalFetch(url, init);
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("a stream that breaks after the first tokens ends as a failed attempt, frees the slot and does not hang the client", { timeout: 20_000 }, async () => {
  await withManagedCodex(["mid_a"], () => brokenStream(), async (ctx) => {
    const response = await ctx.send({ body: { stream: true } });
    const received = await readWithoutHanging(response);
    await sleep(100);

    assert.match(received, /"content":"Hel"/, "tokens sent before the break reach the client");
    assert.ok(!received.includes("[DONE]"), "a broken stream must not look like a finished one");

    const [attempt, ...rest] = ctx.listAttempts();
    assert.equal(rest.length, 0);
    assert.equal(attempt.state, "failed");
    assert.equal(attempt.terminalReason, "upstream_error");
    assert.ok(attempt.finishedAt);
    assertNoSlotHeld(ctx, ["mid_a"]);
  });
});

test("a stream that breaks before a non-streaming client gets its answer returns a gateway error and frees the slot", { timeout: 20_000 }, async () => {
  await withManagedCodex(["mid_json_a"], () => brokenStream(), async (ctx) => {
    const response = await ctx.send({ body: { stream: false } });
    const body = await readWithoutHanging(response);

    assert.equal(response.status, 502);
    assert.equal(JSON.parse(body).error.code, "bad_gateway");
    const [attempt] = ctx.listAttempts();
    assert.equal(attempt.state, "failed");
    assertNoSlotHeld(ctx, ["mid_json_a"]);
  });
});

test("a 401 that is fixed by a token refresh and then answered with 429 fails over to another account and frees the first slot", { timeout: 20_000 }, async () => {
  const restoreFetch = stubTokenEndpoint();
  try {
    await withManagedCodex(
      ["rf_a", "rf_b"],
      (args, index) => {
        if (index === 0) return jsonResponse(401, { error: { message: "Token expired" } });
        if (index === 1) return jsonResponse(429, { error: { message: "Rate limit reached" } });
        return healthyStream();
      },
      async (ctx) => {
        const response = await ctx.send();
        await readWithoutHanging(response);
        await sleep(100);

        assert.equal(response.status, 200);
        assert.equal(ctx.calls.length, 3);
        const [first, retry, other] = ctx.calls;
        assert.equal(retry.connectionId, first.connectionId, "the retry stays on the refreshed account");
        assert.equal(retry.accessToken, "refreshed_access_token");
        assert.notEqual(other.connectionId, first.connectionId, "then the request moves to the other account");

        const attempts = ctx.listAttempts();
        const firstAttempt = attempts.find((a) => a.connectionId === first.connectionId);
        const servedAttempt = attempts.find((a) => a.connectionId === other.connectionId);
        assert.equal(firstAttempt.state, "failed");
        assert.equal(servedAttempt.state, "completed");
        assertNoSlotHeld(ctx, ["rf_a", "rf_b"]);
      },
    );
  } finally {
    restoreFetch();
  }
});

test("a 429 that follows a successful token refresh is reported as a rate limit and does not deactivate the account", {
  timeout: 20_000,
}, async () => {
  const restoreFetch = stubTokenEndpoint();
  try {
    await withManagedCodex(
      ["rf_solo"],
      (args, index) =>
        index === 0
          ? jsonResponse(401, { error: { message: "Token expired" } })
          : jsonResponse(429, { error: { message: "Rate limit reached" } }),
      async ({ send, getConnection }) => {
        const response = await send();
        const account = await getConnection("rf_solo");

        assert.equal(response.status, 429);
        assert.equal(account.isActive, true, "a refreshed, rate limited account is not logged out");
        // error_code is a TEXT column; numeric codes come back as "429.0".
        assert.equal(Number(account.errorCode), 429);
        assert.ok(account["modelLock_gpt-5-codex"], "the account is cooling down for this model");
      },
    );
  } finally {
    restoreFetch();
  }
});

test("when every account answers 429 the request ends with that 429 after trying each account once", {
  timeout: 20_000,
}, async () => {
  await withManagedCodex(
    ["all429_a", "all429_b", "all429_c"],
    () => jsonResponse(429, { error: { message: "Rate limit reached" } }),
    async ({ send, calls }) => {
      const client = new AbortController();
      const pending = send({ signal: client.signal });
      const outcome = await Promise.race([pending, sleep(3000).then(() => "__STILL_RUNNING__")]);
      // Let go of the request so the test run does not wait for it.
      client.abort();
      await pending;

      assert.notEqual(outcome, "__STILL_RUNNING__", "the request should have ended with the 429");
      assert.equal(outcome.status, 429);
      assert.equal(calls.length, 3);
    },
  );
});

test("a client that disconnects while its request is running ends the attempt as cancelled and frees the slot", { timeout: 20_000 }, async () => {
  await withManagedCodex(["abort_a"], hangUntilAborted, async (ctx) => {
    const client = new AbortController();
    const pending = ctx.send({ signal: client.signal });
    await sleep(150);
    client.abort();

    const response = await pending;
    assert.equal(response.status, 499);
    const [attempt] = ctx.listAttempts();
    assert.equal(attempt.state, "cancelled");
    assert.equal(attempt.terminalReason, "client_disconnected");
    assertNoSlotHeld(ctx, ["abort_a"]);
  });
});

test("a client that disconnects mid-request does not put a healthy account into cooldown", {
  timeout: 20_000,
}, async () => {
  await withManagedCodex(["abort_lock_a"], hangUntilAborted, async ({ send, getConnection }) => {
    const client = new AbortController();
    const pending = send({ signal: client.signal });
    await sleep(150);
    client.abort();
    await pending;

    const account = await getConnection("abort_lock_a");
    assert.equal(account["modelLock_gpt-5-codex"], undefined);
    assert.notEqual(Number(account.errorCode), 499);
  });
});

test("after a mixed burst of successes, a failover, broken streams and abandoned requests no slot or attempt is left behind", { timeout: 30_000 }, async () => {
  const accounts = ["burst_a", "burst_b", "burst_c"];
  // Which kind of upstream behaviour a request gets is read from its own text.
  let flakyAlreadyFailed = false;
  const kindOf = (args) => /kind:(\w+)/.exec(JSON.stringify(args.body))[1];
  const respond = async (args) => {
    switch (kindOf(args)) {
      case "slow":
        await sleep(300);
        return healthyStream();
      case "ok":
        await sleep(30);
        return healthyStream();
      case "broken":
        return brokenStream();
      case "flaky":
        // The first account it lands on rate limits it; the retry elsewhere succeeds.
        if (!flakyAlreadyFailed) {
          flakyAlreadyFailed = true;
          return jsonResponse(429, { error: { message: "Rate limit reached" } });
        }
        return healthyStream();
      default:
        throw new Error(`unexpected request kind in ${JSON.stringify(args.body)}`);
    }
  };
  const message = (kind) => ({
    messages: [{ role: "user", content: `Summarise this ticket. kind:${kind}` }],
  });

  await withManagedCodex(accounts, respond, async (ctx) => {
    // Like a real client, every request reads its answer while the others run.
    const pending = [];
    const request = (options) =>
      pending.push(ctx.send(options).then((response) => readWithoutHanging(response)));
    const fire = (kind, extra = {}) => request({ body: { ...message(kind), ...extra } });

    // Three slow requests take every slot, so the rest of the burst has to queue.
    for (let i = 0; i < 3; i++) fire("slow");
    await sleep(30);
    for (let i = 0; i < 4; i++) {
      const client = new AbortController();
      setTimeout(() => client.abort(), 100);
      request({ signal: client.signal, body: message("ok") });
    }
    for (let i = 0; i < 3; i++) fire("ok", { stream: true });
    for (let i = 0; i < 3; i++) fire("broken", { stream: true });
    // A rate limit cools the account down, so the flaky request goes last in the queue.
    await sleep(30);
    fire("flaky");

    await Promise.all(pending);
    await sleep(200);

    const states = ctx.listAttempts().map((attempt) => attempt.state);
    for (const expected of ["completed", "failed", "cancelled"]) {
      assert.ok(states.includes(expected), `the burst should produce a ${expected} attempt`);
    }
    assert.ok(
      states.every((state) => ["completed", "failed", "cancelled"].includes(state)),
      `attempts left unfinished: ${states.join(",")}`,
    );
    assertNoSlotHeld(ctx, accounts);
  });
});
