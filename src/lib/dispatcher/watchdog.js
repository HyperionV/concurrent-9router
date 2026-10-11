import { randomUUID } from "node:crypto";
import {
  getLatestDispatchAttemptForRequest,
  insertDispatchAttemptEvent,
  listActiveDispatchAttempts,
  listQueuedDispatchRequests,
} from "@/lib/sqlite/dispatcherStore.js";
import {
  classifyAttemptTimeout,
  createTimeoutPolicy,
} from "@/lib/dispatcher/timeoutPolicy.js";
import {
  DEFAULT_TERMINAL_REASON,
  DISPATCH_ATTEMPT_STATE,
  DISPATCH_EVENT_TYPE,
} from "@/lib/dispatcher/types.js";
import { queueWaitLimitMs } from "@/lib/dispatcher/priorityQueue.js";

export function createDispatcherWatchdog({
  provider = "codex",
  dispatcher,
  timeoutPolicy = {},
} = {}) {
  if (!dispatcher) {
    throw new Error("createDispatcherWatchdog requires dispatcher");
  }

  const policy = createTimeoutPolicy(timeoutPolicy);
  const hasExplicitQueueLimit =
    timeoutPolicy.waitingLimitMs != null || timeoutPolicy.queueTtlMs != null;

  async function runSweep(now = Date.now()) {
    const timedOut = [];
    const queuedRequests = listQueuedDispatchRequests(provider, 500);
    const activeAttempts = listActiveDispatchAttempts(provider);

    for (const request of queuedRequests) {
      const pseudoAttempt = {
        queueEnteredAt: request.queuedAt,
      };
      // A queued request may wait as long as its class allows, unless the
      // watchdog was given an explicit queue limit.
      const queuePolicy = hasExplicitQueueLimit
        ? policy
        : { ...policy, waitingLimitMs: queueWaitLimitMs(request) };
      const timeoutKind = classifyAttemptTimeout(pseudoAttempt, queuePolicy, now);
      if (timeoutKind !== "queue_expired") continue;

      const queuedAttempt = getLatestDispatchAttemptForRequest(request.id);
      if (
        !queuedAttempt ||
        queuedAttempt.state !== DISPATCH_ATTEMPT_STATE.QUEUED
      ) {
        continue;
      }

      const attempt = await dispatcher.failAttempt?.(queuedAttempt.id, {
        nextState: DISPATCH_ATTEMPT_STATE.TIMED_OUT,
        terminalReason: DEFAULT_TERMINAL_REASON.TIMEOUT,
        timeoutKind,
      });
      timedOut.push({ requestId: request.id, timeoutKind, attempt });
    }

    for (const attempt of activeAttempts) {
      const timeoutKind = classifyAttemptTimeout(attempt, policy, now);
      if (!timeoutKind) continue;

      await dispatcher.failAttempt(attempt.id, {
        nextState: DISPATCH_ATTEMPT_STATE.TIMED_OUT,
        terminalReason: DEFAULT_TERMINAL_REASON.TIMEOUT,
        timeoutKind,
      });
      insertDispatchAttemptEvent({
        id: randomUUID(),
        attemptId: attempt.id,
        eventType: DISPATCH_EVENT_TYPE.TIMED_OUT,
        payload: {
          timeoutKind,
          state: attempt.state,
        },
      });
      timedOut.push({ attemptId: attempt.id, timeoutKind });
    }

    return { timedOut };
  }

  return {
    runSweep,
    timeoutPolicy: policy,
  };
}
