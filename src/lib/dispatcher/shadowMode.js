import { randomUUID } from "node:crypto";
import {
  insertDispatchAttempt,
  insertDispatchAttemptEvent,
  insertDispatchRequest,
  transitionDispatchAttempt,
  updateDispatchRequestStatus,
} from "@/lib/sqlite/dispatcherStore.js";
import { nowIso } from "@/lib/sqlite/helpers.js";
import { persistConversationAffinity } from "@/lib/dispatcher/conversationAffinity.js";

export function beginShadowCodexAttempt({
  provider = "codex",
  modelId,
  routeModel,
  sourceEndpoint = null,
  sourceFormat = null,
  targetFormat = null,
  conversationKey = null,
  connectionId = null,
  pathMode = null,
  sessionId = null,
  apiKeyId = null,
} = {}) {
  const requestId = randomUUID();
  const attemptId = randomUUID();
  const queuedAt = nowIso();
  let finalized = false;

  insertDispatchRequest({
    id: requestId,
    provider,
    modelId,
    sourceEndpoint,
    sourceFormat,
    targetFormat,
    conversationKey,
    requestKind: "chat",
    status: "running",
    queuedAt,
    metadata: {
      executionMode: "shadow",
      routeModel,
      apiKeyId,
    },
  });

  insertDispatchAttempt({
    id: attemptId,
    requestId,
    attemptIndex: 0,
    provider,
    modelId,
    connectionId,
    leaseKey: connectionId ? `${connectionId}:${randomUUID()}` : null,
    state: "leased",
    pathMode,
    queueEnteredAt: queuedAt,
    leasedAt: queuedAt,
  });

  insertDispatchAttemptEvent({
    id: randomUUID(),
    attemptId,
    eventType: "enqueued",
    payload: {
      requestId,
      conversationKey,
      executionMode: "shadow",
    },
  });
  insertDispatchAttemptEvent({
    id: randomUUID(),
    attemptId,
    eventType: "leased",
    payload: {
      connectionId,
      executionMode: "shadow",
    },
  });

  async function markAttemptState(
    fromStates,
    nextState,
    eventType,
    updates = {},
  ) {
    const attempt = transitionDispatchAttempt(
      attemptId,
      fromStates,
      nextState,
      updates,
    );
    if (!attempt) return null;
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType,
      payload: {
        ...updates,
        executionMode: "shadow",
      },
    });
    return attempt;
  }

  async function finalize(nextState, terminalReason, error = {}) {
    if (finalized) return null;
    finalized = true;
    const attempt = transitionDispatchAttempt(
      attemptId,
      ["leased", "connecting", "streaming"],
      nextState,
      {
        finishedAt: nowIso(),
        terminalReason,
        error,
      },
    );
    if (!attempt) return null;
    updateDispatchRequestStatus(
      requestId,
      nextState === "completed" ? "completed" : "failed",
      {
        completedAt: nowIso(),
      },
    );
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType: nextState === "completed" ? "completed" : "failed",
      payload: {
        terminalReason,
        error,
        executionMode: "shadow",
      },
    });
    return attempt;
  }

  return {
    requestId,
    attemptId,
    dispatcherHooks: {
      onConnectStarted: async ({ pathMode: nextPathMode = null } = {}) =>
        markAttemptState("leased", "connecting", "connect_started", {
          connectStartedAt: nowIso(),
          pathMode: nextPathMode,
        }),
      onStreamStarted: async () =>
        markAttemptState(
          ["leased", "connecting"],
          "streaming",
          "stream_started",
          {
            streamStartedAt: nowIso(),
          },
        ),
      onFirstProgress: async () =>
        markAttemptState(
          ["connecting", "streaming"],
          "streaming",
          "first_progress",
          {
            firstProgressAt: nowIso(),
            lastProgressAt: nowIso(),
          },
        ),
      onResponseIdentity: async () => null,
    },
    finalizeSuccess: async (terminalReason = "success") =>
      finalize("completed", terminalReason),
    finalizeFailure: async (terminalReason = "error", error = {}) =>
      finalize("failed", terminalReason, error),
  };
}
