import test from "node:test";
import assert from "node:assert/strict";

import { classifyAttemptTimeout } from "@/lib/dispatcher/timeoutPolicy.js";

const MINUTE = 60_000;
const iso = (ms) => new Date(ms).toISOString();

test("a streaming attempt with fresh progress is not killed by the queue limit", () => {
  const now = Date.now();
  const enteredQueue = now - 5 * MINUTE - 10_000;
  const attempt = {
    state: "streaming",
    queueEnteredAt: iso(enteredQueue),
    leasedAt: iso(enteredQueue + 1_000),
    connectStartedAt: iso(enteredQueue + 1_000),
    streamStartedAt: iso(enteredQueue + 2_000),
    firstProgressAt: iso(enteredQueue + 3_000),
    lastProgressAt: iso(now - 1_000),
  };

  assert.equal(classifyAttemptTimeout(attempt, {}, now), null);
});

test("a request still waiting in the queue expires at the queue limit", () => {
  const now = Date.now();
  const queuedRequest = { queueEnteredAt: iso(now - 5 * MINUTE - 1_000) };

  assert.equal(classifyAttemptTimeout(queuedRequest, {}, now), "queue_expired");
});

test("a running attempt still hits its deadline measured from the lease", () => {
  const now = Date.now();
  const leasedAt = now - 6 * MINUTE - 1_000;
  const attempt = {
    state: "streaming",
    queueEnteredAt: iso(leasedAt - 60_000),
    leasedAt: iso(leasedAt),
    connectStartedAt: iso(leasedAt),
    firstProgressAt: iso(leasedAt + 1_000),
    lastProgressAt: iso(now - 1_000),
  };

  assert.equal(classifyAttemptTimeout(attempt, {}, now), "attempt_deadline");
});
