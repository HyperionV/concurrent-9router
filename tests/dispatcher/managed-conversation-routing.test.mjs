/**
 * Conversation pinning and session isolation for managed Codex requests,
 * end to end through the real dispatcher and SQLite ledger. Only the upstream
 * HTTP responses are stubbed.
 *
 * Every test uses its own account ids so per-account memory never leaks between tests.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { jsonResponse, sleep, withManagedCodex } from "./managed-codex-harness.mjs";

const SSE_COMPLETED =
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[]}}\n\n';

const completedStream = () =>
  new Response(SSE_COMPLETED, { status: 200, headers: { "Content-Type": "text/event-stream" } });

/** One chat turn of `conversationId`; turn 2 onwards carries the earlier exchange, like a real client. */
async function sendTurn({ send }, conversationId, turn) {
  const history = Array.from({ length: turn - 1 }, (_, index) => [
    { role: "user", content: `Question ${index + 1}` },
    { role: "assistant", content: `Answer ${index + 1}` },
  ]).flat();
  const response = await send({
    body: {
      conversation_id: conversationId,
      messages: [...history, { role: "user", content: `Question ${turn}` }],
    },
  });
  await response.text();
  // The attempt is completed once the client has read the answer.
  await sleep(50);
  return response;
}

test("two conversations run on different accounts and each later turn returns to its own account", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["pin_a", "pin_b"],
    async () => {
      await sleep(100);
      return completedStream();
    },
    async (ctx) => {
      // Both first turns overlap, so with one slot per account they must split.
      await Promise.all([sendTurn(ctx, "conv-alpha", 1), sendTurn(ctx, "conv-beta", 1)]);
      const alphaAccount = ctx.getConversationAffinity("conv-alpha").connectionId;
      const betaAccount = ctx.getConversationAffinity("conv-beta").connectionId;
      assert.notEqual(alphaAccount, betaAccount);

      // Second turns arrive in the opposite order.
      const callsBefore = ctx.calls.length;
      await sendTurn(ctx, "conv-beta", 2);
      await sendTurn(ctx, "conv-alpha", 2);

      const [betaTurn2, alphaTurn2] = ctx.calls.slice(callsBefore);
      assert.equal(betaTurn2.connectionId, betaAccount);
      assert.equal(alphaTurn2.connectionId, alphaAccount);
      assert.equal(ctx.getConversationAffinity("conv-alpha").connectionId, alphaAccount);
      assert.equal(ctx.getConversationAffinity("conv-beta").connectionId, betaAccount);
    },
  );
});

test("a conversation's session id travels only with its own account and is never lent to another conversation", { timeout: 20_000 }, async () => {
  await withManagedCodex(["sess_a", "sess_b"], () => completedStream(), async (ctx) => {
    ctx.seedConversationAffinity({ conversationKey: "conv-alpha", connectionId: "sess_a", sessionId: "sess-alpha" });
    ctx.seedConversationAffinity({ conversationKey: "conv-beta", connectionId: "sess_b", sessionId: "sess-beta" });

    await sendTurn(ctx, "conv-beta", 2);
    await sendTurn(ctx, "conv-alpha", 2);
    await sendTurn(ctx, "conv-new", 1);

    const [beta, alpha, brandNew] = ctx.calls;
    assert.deepEqual([beta.connectionId, beta.sessionId], ["sess_b", "sess-beta"]);
    assert.deepEqual([alpha.connectionId, alpha.sessionId], ["sess_a", "sess-alpha"]);
    assert.ok(
      !["sess-alpha", "sess-beta"].includes(brandNew.sessionId),
      "a new conversation must not inherit another conversation's session",
    );

    // Finishing a turn must not rewrite the pairing.
    assert.equal(ctx.getConversationAffinity("conv-alpha").sessionId, "sess-alpha");
    assert.equal(ctx.getConversationAffinity("conv-beta").sessionId, "sess-beta");
  });
});

test("a conversation whose pinned account is rate limited is moved to another account and its pin follows", { timeout: 20_000 }, async () => {
  await withManagedCodex(
    ["move_a", "move_b"],
    (args) =>
      args.credentials.connectionId === "move_a"
        ? jsonResponse(429, { error: { message: "Rate limit reached" } })
        : completedStream(),
    async (ctx) => {
      ctx.seedConversationAffinity({ conversationKey: "conv-omega", connectionId: "move_a" });

      const response = await sendTurn(ctx, "conv-omega", 2);
      assert.equal(response.status, 200);
      assert.deepEqual(ctx.calls.map((call) => call.connectionId), ["move_a", "move_b"]);
      assert.equal(ctx.getConversationAffinity("conv-omega").connectionId, "move_b");

      // The next turn goes straight to the new account instead of retrying the limited one.
      await sendTurn(ctx, "conv-omega", 3);
      assert.deepEqual(ctx.calls.map((call) => call.connectionId), ["move_a", "move_b", "move_b"]);
    },
  );
});
