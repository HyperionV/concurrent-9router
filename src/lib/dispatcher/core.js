import { randomUUID } from "node:crypto";
import {
  getDispatchConversationAffinity,
  getDispatchRequest,
  getLatestDispatchAttemptForRequest,
  insertDispatchAttempt,
  insertDispatchAttemptEvent,
  insertDispatchRequest,
  leaseDispatchAttempt,
  listActiveDispatchAttempts,
  listQueuedDispatchRequests,
  transitionDispatchAttempt,
  updateDispatchRequestStatus,
} from "@/lib/sqlite/dispatcherStore.js";
import { nowIso } from "@/lib/sqlite/helpers.js";
import { createPathHealthTracker } from "@/lib/dispatcher/pathHealth.js";
import { createTimeoutPolicy } from "@/lib/dispatcher/timeoutPolicy.js";
import {
  DEFAULT_TERMINAL_REASON,
  DISPATCH_ATTEMPT_STATE,
  DISPATCH_EVENT_TYPE,
  DISPATCH_REQUEST_STATUS,
} from "@/lib/dispatcher/types.js";
import { isModelLockActive } from "open-sse/services/accountFallback.js";

function buildLeaseKey(connectionId) {
  return `${connectionId}:${randomUUID()}`;
}

function compareConnections(a, b) {
  const priorityDiff = Number(a?.priority ?? 999) - Number(b?.priority ?? 999);
  if (priorityDiff !== 0) return priorityDiff;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function sortRequestsByQueueTime(requests) {
  return [...requests].sort((a, b) =>
    String(a?.queuedAt || "").localeCompare(String(b?.queuedAt || "")),
  );
}

export function createDispatcherCore({
  provider = "codex",
  getConnections,
  slotsPerConnection = 1,
  getSlotsPerConnection = null,
  timeoutPolicy = {},
  pathHealth = createPathHealthTracker(),
} = {}) {
  if (typeof getConnections !== "function") {
    throw new Error("createDispatcherCore requires getConnections");
  }

  const policy = createTimeoutPolicy(timeoutPolicy);
  const occupancyByConnection = {};

  function resolveSlotsPerConnection() {
    if (typeof getSlotsPerConnection === "function") {
      const value = Number(getSlotsPerConnection());
      return Number.isFinite(value) && value > 0 ? value : 1;
    }
    const value = Number(slotsPerConnection || 1);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  function rebuildOccupancy(activeAttempts) {
    for (const key of Object.keys(occupancyByConnection)) {
      delete occupancyByConnection[key];
    }
    for (const attempt of activeAttempts) {
      if (!attempt.connectionId) continue;
      occupancyByConnection[attempt.connectionId] =
        (occupancyByConnection[attempt.connectionId] || 0) + 1;
    }
  }

  async function syncOccupancy() {
    const activeAttempts = listActiveDispatchAttempts(provider);
    rebuildOccupancy(activeAttempts);
    return activeAttempts;
  }

  async function enqueueRequest({
    id = randomUUID(),
    provider: requestProvider = provider,
    modelId,
    sourceEndpoint = null,
    sourceFormat = null,
    targetFormat = null,
    conversationKey = null,
    requestKind = "chat",
    metadata = {},
    expiresAt = null,
  }) {
    const queuedAt = nowIso();
    const request = insertDispatchRequest({
      id,
      provider: requestProvider,
      modelId,
      sourceEndpoint,
      sourceFormat,
      targetFormat,
      conversationKey,
      requestKind,
      status: DISPATCH_REQUEST_STATUS.QUEUED,
      queuedAt,
      expiresAt,
      metadata,
    });

    const latestAttempt = getLatestDispatchAttemptForRequest(request.id);
    const attemptIndex = latestAttempt ? latestAttempt.attemptIndex + 1 : 0;
    const attempt = insertDispatchAttempt({
      id: randomUUID(),
      requestId: request.id,
      attemptIndex,
      provider: request.provider,
      modelId: request.modelId,
      state: DISPATCH_ATTEMPT_STATE.QUEUED,
      queueEnteredAt: queuedAt,
    });

    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId: attempt.id,
      eventType: DISPATCH_EVENT_TYPE.ENQUEUED,
      payload: {
        requestId: request.id,
        conversationKey: request.conversationKey,
      },
    });

    return { request, attempt };
  }

  async function requeueRequest(
    requestId,
    { metadataPatch = {}, previousAttemptId = null } = {},
  ) {
    const request = getDispatchRequest(requestId);
    if (!request) return null;

    const latestAttempt = getLatestDispatchAttemptForRequest(request.id);
    const attempt = insertDispatchAttempt({
      id: randomUUID(),
      requestId: request.id,
      attemptIndex: latestAttempt ? latestAttempt.attemptIndex + 1 : 0,
      provider: request.provider,
      modelId: request.modelId,
      state: DISPATCH_ATTEMPT_STATE.QUEUED,
      queueEnteredAt: nowIso(),
    });

    updateDispatchRequestStatus(request.id, DISPATCH_REQUEST_STATUS.QUEUED, {
      metadata: {
        ...(request.metadata || {}),
        ...metadataPatch,
      },
    });

    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId: attempt.id,
      eventType: DISPATCH_EVENT_TYPE.ENQUEUED,
      payload: {
        requestId: request.id,
        previousAttemptId,
        retry: previousAttemptId != null,
      },
    });

    return { request, attempt };
  }

  function requestIsEligibleForConnection(
    request,
    connectionId,
    activeAttempts,
  ) {
    const conversationKey = request?.conversationKey;
    if (!conversationKey) return true;

    const affinity = getDispatchConversationAffinity(conversationKey);
    if (
      affinity &&
      affinity.connectionId &&
      affinity.connectionId !== connectionId
    ) {
      return false;
    }

    return !activeAttempts.some(
      (attempt) =>
        attempt.requestId === request.id ||
        (request.conversationKey &&
          getDispatchRequest(attempt.requestId)?.conversationKey ===
            request.conversationKey &&
          attempt.connectionId !== connectionId),
    );
  }

  function connectionCanServeRequest(connection, request) {
    const rawConnection = connection?._connection || connection;
    return !isModelLockActive(rawConnection, request?.modelId || null);
  }

  function getSortedConnections(connections) {
    return [...connections]
      .filter((connection) => connection?.id)
      .sort((a, b) => {
        const occupancyDiff =
          (occupancyByConnection[a.id] || 0) -
          (occupancyByConnection[b.id] || 0);
        if (occupancyDiff !== 0) return occupancyDiff;
        const pathScoreDiff =
          pathHealth.rankConnection(b, occupancyByConnection[b.id] || 0) -
          pathHealth.rankConnection(a, occupancyByConnection[a.id] || 0);
        if (pathScoreDiff !== 0) return pathScoreDiff;
        return compareConnections(a, b);
      });
  }

  function planLeases(queuedRequests, connections, activeAttempts) {
    const leasePlan = [];
    const leasedRequestIds = new Set();

    for (const connection of getSortedConnections(connections)) {
      const currentOccupancy = occupancyByConnection[connection.id] || 0;
      const remainingSlots = Math.max(
        0,
        resolveSlotsPerConnection() - currentOccupancy,
      );
      if (remainingSlots === 0) continue;

      for (let slot = 0; slot < remainingSlots; slot++) {
        const request = queuedRequests.find(
          (candidate) =>
            !leasedRequestIds.has(candidate.id) &&
            connectionCanServeRequest(connection, candidate) &&
            requestIsEligibleForConnection(
              candidate,
              connection.id,
              activeAttempts,
            ),
        );
        if (!request) break;
        leasedRequestIds.add(request.id);
        leasePlan.push({ requestId: request.id, connection });
      }
    }

    return leasePlan;
  }

  async function tryLeaseAvailableWork() {
    const [connections, activeAttempts] = await Promise.all([
      getConnections(),
      syncOccupancy(),
    ]);
    const queuedRequests = sortRequestsByQueueTime(
      listQueuedDispatchRequests(provider, 500),
    );
    const leases = [];

    for (const plannedLease of planLeases(
      queuedRequests,
      connections,
      activeAttempts,
    )) {
      const request = queuedRequests.find(
        (candidate) => candidate.id === plannedLease.requestId,
      );
      const connection = plannedLease.connection;
      const attempt = getLatestDispatchAttemptForRequest(request.id);
      if (!attempt || attempt.state !== DISPATCH_ATTEMPT_STATE.QUEUED) {
        continue;
      }

      const leasedAt = nowIso();
      const leaseKey = buildLeaseKey(connection.id);
      const leased = leaseDispatchAttempt(attempt.id, {
        connectionId: connection.id,
        leaseKey,
        leasedAt,
        pathMode: connection?.providerSpecificData?.vercelRelayUrl
          ? "vercel-relay"
          : connection?.providerSpecificData?.connectionProxyEnabled
            ? "connection-proxy"
            : "direct",
      });
      if (!leased) {
        continue;
      }

      updateDispatchRequestStatus(request.id, DISPATCH_REQUEST_STATUS.RUNNING);
      occupancyByConnection[connection.id] =
        (occupancyByConnection[connection.id] || 0) + 1;

      insertDispatchAttemptEvent({
        id: randomUUID(),
        attemptId: leased.id,
        eventType: DISPATCH_EVENT_TYPE.LEASED,
        payload: {
          connectionId: connection.id,
          leaseKey,
        },
      });

      leases.push({
        requestId: request.id,
        attemptId: leased.id,
        connectionId: connection.id,
        connection,
        request,
        attempt: leased,
      });
    }

    return leases;
  }

  async function tryLeaseRequest(requestId) {
    const [connections, activeAttempts] = await Promise.all([
      getConnections(),
      syncOccupancy(),
    ]);
    const queuedRequests = sortRequestsByQueueTime(
      listQueuedDispatchRequests(provider, 500),
    );
    const targetRequest = queuedRequests.find(
      (request) => request.id === requestId,
    );
    if (!targetRequest) return null;

    const plannedLease = planLeases(
      queuedRequests,
      connections,
      activeAttempts,
    ).find((lease) => lease.requestId === requestId);
    if (!plannedLease) return null;

    const attempt = getLatestDispatchAttemptForRequest(requestId);
    if (!attempt || attempt.state !== DISPATCH_ATTEMPT_STATE.QUEUED)
      return null;

    const connection = plannedLease.connection;
    const leasedAt = nowIso();
    const leaseKey = buildLeaseKey(connection.id);
    const leased = leaseDispatchAttempt(attempt.id, {
      connectionId: connection.id,
      leaseKey,
      leasedAt,
      pathMode: connection?.providerSpecificData?.vercelRelayUrl
        ? "vercel-relay"
        : connection?.providerSpecificData?.connectionProxyEnabled
          ? "connection-proxy"
          : "direct",
    });
    if (!leased) return null;

    updateDispatchRequestStatus(requestId, DISPATCH_REQUEST_STATUS.RUNNING);
    occupancyByConnection[connection.id] =
      (occupancyByConnection[connection.id] || 0) + 1;

    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId: leased.id,
      eventType: DISPATCH_EVENT_TYPE.LEASED,
      payload: {
        connectionId: connection.id,
        leaseKey,
      },
    });

    return {
      requestId,
      attemptId: leased.id,
      connectionId: connection.id,
      connection,
      request: targetRequest,
      attempt: leased,
    };
  }

  function finalizeRequestForAttempt(attempt, nextState) {
    const requestState =
      nextState === DISPATCH_ATTEMPT_STATE.COMPLETED
        ? DISPATCH_REQUEST_STATUS.COMPLETED
        : nextState === DISPATCH_ATTEMPT_STATE.CANCELLED
          ? DISPATCH_REQUEST_STATUS.CANCELLED
          : nextState === DISPATCH_ATTEMPT_STATE.TIMED_OUT
            ? DISPATCH_REQUEST_STATUS.TIMED_OUT
            : DISPATCH_REQUEST_STATUS.FAILED;
    updateDispatchRequestStatus(attempt.requestId, requestState, {
      completedAt: nowIso(),
    });
  }

  function releaseConnectionOccupancy(connectionId) {
    if (!connectionId) return;
    occupancyByConnection[connectionId] = Math.max(
      0,
      (occupancyByConnection[connectionId] || 1) - 1,
    );
  }

  async function markAttemptState(
    attemptId,
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
      payload: updates,
    });
    return attempt;
  }

  async function markAttemptConnecting(attemptId, updates = {}) {
    return markAttemptState(
      attemptId,
      DISPATCH_ATTEMPT_STATE.LEASED,
      DISPATCH_ATTEMPT_STATE.CONNECTING,
      DISPATCH_EVENT_TYPE.CONNECT_STARTED,
      {
        connectStartedAt: updates.connectStartedAt || nowIso(),
        pathMode: updates.pathMode || null,
      },
    );
  }

  async function markAttemptStreamStarted(attemptId, updates = {}) {
    return markAttemptState(
      attemptId,
      [DISPATCH_ATTEMPT_STATE.LEASED, DISPATCH_ATTEMPT_STATE.CONNECTING],
      DISPATCH_ATTEMPT_STATE.STREAMING,
      DISPATCH_EVENT_TYPE.STREAM_STARTED,
      {
        streamStartedAt: updates.streamStartedAt || nowIso(),
        pathMode: updates.pathMode || null,
      },
    );
  }

  async function markAttemptProgress(attemptId, updates = {}) {
    const at = updates.at || nowIso();
    const progress = transitionDispatchAttempt(
      attemptId,
      [DISPATCH_ATTEMPT_STATE.CONNECTING, DISPATCH_ATTEMPT_STATE.STREAMING],
      DISPATCH_ATTEMPT_STATE.STREAMING,
      {
        firstProgressAt: updates.firstProgressAt || at,
        lastProgressAt: updates.lastProgressAt || at,
      },
    );
    if (!progress) return null;
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType:
        progress.firstProgressAt === progress.lastProgressAt
          ? DISPATCH_EVENT_TYPE.FIRST_PROGRESS
          : DISPATCH_EVENT_TYPE.LAST_PROGRESS,
      payload: {
        at,
      },
    });
    return progress;
  }

  async function completeAttempt(
    attemptId,
    { terminalReason = DEFAULT_TERMINAL_REASON.SUCCESS } = {},
  ) {
    const attempt = transitionDispatchAttempt(
      attemptId,
      [
        DISPATCH_ATTEMPT_STATE.LEASED,
        DISPATCH_ATTEMPT_STATE.CONNECTING,
        DISPATCH_ATTEMPT_STATE.STREAMING,
      ],
      DISPATCH_ATTEMPT_STATE.COMPLETED,
      {
        finishedAt: nowIso(),
        terminalReason,
      },
    );
    if (!attempt) return null;

    releaseConnectionOccupancy(attempt.connectionId);
    finalizeRequestForAttempt(attempt, DISPATCH_ATTEMPT_STATE.COMPLETED);
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType: DISPATCH_EVENT_TYPE.COMPLETED,
      payload: { terminalReason },
    });
    return attempt;
  }

  async function failAttempt(
    attemptId,
    {
      nextState = DISPATCH_ATTEMPT_STATE.FAILED,
      terminalReason = DEFAULT_TERMINAL_REASON.ERROR,
      timeoutKind = null,
      error = {},
    } = {},
  ) {
    const attempt = transitionDispatchAttempt(
      attemptId,
      [
        DISPATCH_ATTEMPT_STATE.QUEUED,
        DISPATCH_ATTEMPT_STATE.LEASED,
        DISPATCH_ATTEMPT_STATE.CONNECTING,
        DISPATCH_ATTEMPT_STATE.STREAMING,
      ],
      nextState,
      {
        finishedAt: nowIso(),
        terminalReason,
        timeoutKind,
        error,
      },
    );
    if (!attempt) return null;

    releaseConnectionOccupancy(attempt.connectionId);
    finalizeRequestForAttempt(attempt, nextState);
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType:
        nextState === DISPATCH_ATTEMPT_STATE.TIMED_OUT
          ? DISPATCH_EVENT_TYPE.TIMED_OUT
          : nextState === DISPATCH_ATTEMPT_STATE.CANCELLED
            ? DISPATCH_EVENT_TYPE.CANCELLED
            : DISPATCH_EVENT_TYPE.FAILED,
      payload: {
        terminalReason,
        timeoutKind,
        error,
      },
    });
    return attempt;
  }

  function getInMemorySnapshot() {
    return {
      occupancyByConnection: { ...occupancyByConnection },
      timeoutPolicy: { ...policy },
      pathHealth: pathHealth.snapshot(),
    };
  }

  return {
    enqueueRequest,
    requeueRequest,
    tryLeaseAvailableWork,
    tryLeaseRequest,
    markAttemptConnecting,
    markAttemptStreamStarted,
    markAttemptProgress,
    completeAttempt,
    failAttempt,
    getInMemorySnapshot,
    timeoutPolicy: policy,
    pathHealth,
  };
}
