import { randomUUID } from "node:crypto";
import {
  getImageDispatchRequest,
  getLatestImageDispatchAttemptForRequest,
  insertImageDispatchAttempt,
  insertImageDispatchAttemptEvent,
  insertImageDispatchRequest,
  leaseImageDispatchAttempt,
  listActiveImageDispatchAttempts,
  listQueuedImageDispatchRequests,
  transitionImageDispatchAttempt,
  updateImageDispatchRequestStatus,
} from "@/lib/sqlite/imageDispatcherStore.js";
import { nowIso } from "@/lib/sqlite/helpers.js";
import {
  DEFAULT_TERMINAL_REASON,
  DISPATCH_ATTEMPT_STATE,
  DISPATCH_EVENT_TYPE,
  DISPATCH_REQUEST_STATUS,
} from "@/lib/dispatcher/types.js";

function buildLeaseKey(connectionId) {
  return `${connectionId}:${randomUUID()}`;
}

function sortRequestsByQueueTime(requests) {
  return [...requests].sort((a, b) =>
    String(a?.queuedAt || "").localeCompare(String(b?.queuedAt || "")),
  );
}

function compareConnections(a, b) {
  const priorityDiff = Number(a?.priority ?? 999) - Number(b?.priority ?? 999);
  if (priorityDiff !== 0) return priorityDiff;
  return String(a?.id || "").localeCompare(String(b?.id || ""));
}

function resolvePathMode(connection) {
  return connection?.providerSpecificData?.vercelRelayUrl
    ? "vercel-relay"
    : connection?.providerSpecificData?.connectionProxyEnabled
      ? "connection-proxy"
      : "direct";
}

export function createImageDispatcherCore({
  provider = "codex",
  getConnections,
} = {}) {
  if (typeof getConnections !== "function") {
    throw new Error("createImageDispatcherCore requires getConnections");
  }

  const occupancyByConnection = {};

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
    const activeAttempts = listActiveImageDispatchAttempts(provider);
    rebuildOccupancy(activeAttempts);
    return activeAttempts;
  }

  async function enqueueRequest({
    id = randomUUID(),
    provider: requestProvider = provider,
    modelId,
    sourceEndpoint = "/v1/images/generations",
    sourceFormat = "openai",
    targetFormat = "codex-image",
    conversationKey = null,
    requestKind = "image",
    metadata = {},
    expiresAt = null,
  }) {
    const queuedAt = nowIso();
    const request = insertImageDispatchRequest({
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

    const latestAttempt = getLatestImageDispatchAttemptForRequest(request.id);
    const attempt = insertImageDispatchAttempt({
      id: randomUUID(),
      requestId: request.id,
      attemptIndex: latestAttempt ? latestAttempt.attemptIndex + 1 : 0,
      provider: request.provider,
      modelId: request.modelId,
      state: DISPATCH_ATTEMPT_STATE.QUEUED,
      queueEnteredAt: queuedAt,
    });

    insertImageDispatchAttemptEvent({
      id: randomUUID(),
      attemptId: attempt.id,
      eventType: DISPATCH_EVENT_TYPE.ENQUEUED,
      payload: { requestId: request.id },
    });

    return { request, attempt };
  }

  function sortConnectionsForRequest(connections, request) {
    const preferredConnectionId = request?.metadata?.preferredConnectionId;
    return [...connections]
      .filter((connection) => connection?.id)
      .sort((a, b) => {
        const preferredDiff =
          (a.id === preferredConnectionId ? 0 : 1) -
          (b.id === preferredConnectionId ? 0 : 1);
        if (preferredDiff !== 0) return preferredDiff;
        const occupancyDiff =
          (occupancyByConnection[a.id] || 0) -
          (occupancyByConnection[b.id] || 0);
        if (occupancyDiff !== 0) return occupancyDiff;
        return compareConnections(a, b);
      });
  }

  function planLeaseForRequest(request, connections) {
    return sortConnectionsForRequest(connections, request).find(
      (connection) => (occupancyByConnection[connection.id] || 0) < 1,
    );
  }

  async function tryLeaseRequest(requestId) {
    const [connections] = await Promise.all([
      getConnections(),
      syncOccupancy(),
    ]);
    const queuedRequests = sortRequestsByQueueTime(
      listQueuedImageDispatchRequests(provider, 500),
    );
    const targetRequest = queuedRequests.find(
      (request) => request.id === requestId,
    );
    if (!targetRequest) return null;

    const connection = planLeaseForRequest(targetRequest, connections);
    if (!connection) return null;

    const attempt = getLatestImageDispatchAttemptForRequest(requestId);
    if (!attempt || attempt.state !== DISPATCH_ATTEMPT_STATE.QUEUED) {
      return null;
    }

    const leasedAt = nowIso();
    const leaseKey = buildLeaseKey(connection.id);
    const leased = leaseImageDispatchAttempt(attempt.id, {
      connectionId: connection.id,
      leaseKey,
      leasedAt,
      pathMode: resolvePathMode(connection),
    });
    if (!leased) return null;

    updateImageDispatchRequestStatus(
      requestId,
      DISPATCH_REQUEST_STATUS.RUNNING,
    );
    occupancyByConnection[connection.id] =
      (occupancyByConnection[connection.id] || 0) + 1;

    insertImageDispatchAttemptEvent({
      id: randomUUID(),
      attemptId: leased.id,
      eventType: DISPATCH_EVENT_TYPE.LEASED,
      payload: { connectionId: connection.id, leaseKey },
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

  async function tryLeaseAvailableWork() {
    const queuedRequests = sortRequestsByQueueTime(
      listQueuedImageDispatchRequests(provider, 500),
    );
    const leases = [];
    for (const request of queuedRequests) {
      const lease = await tryLeaseRequest(request.id);
      if (lease) leases.push(lease);
    }
    return leases;
  }

  function releaseConnectionOccupancy(connectionId) {
    if (!connectionId) return;
    occupancyByConnection[connectionId] = Math.max(
      0,
      (occupancyByConnection[connectionId] || 1) - 1,
    );
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
    updateImageDispatchRequestStatus(attempt.requestId, requestState, {
      completedAt: nowIso(),
    });
  }

  async function markAttemptConnecting(attemptId, updates = {}) {
    const attempt = transitionImageDispatchAttempt(
      attemptId,
      DISPATCH_ATTEMPT_STATE.LEASED,
      DISPATCH_ATTEMPT_STATE.CONNECTING,
      {
        connectStartedAt: updates.connectStartedAt || nowIso(),
        pathMode: updates.pathMode || null,
      },
    );
    if (!attempt) return null;
    insertImageDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType: DISPATCH_EVENT_TYPE.CONNECT_STARTED,
      payload: updates,
    });
    return attempt;
  }

  async function markAttemptStreamStarted(attemptId, updates = {}) {
    const attempt = transitionImageDispatchAttempt(
      attemptId,
      [DISPATCH_ATTEMPT_STATE.LEASED, DISPATCH_ATTEMPT_STATE.CONNECTING],
      DISPATCH_ATTEMPT_STATE.STREAMING,
      {
        streamStartedAt: updates.streamStartedAt || nowIso(),
        pathMode: updates.pathMode || null,
      },
    );
    if (!attempt) return null;
    insertImageDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType: DISPATCH_EVENT_TYPE.STREAM_STARTED,
      payload: updates,
    });
    return attempt;
  }

  async function markAttemptProgress(attemptId, updates = {}) {
    const at = updates.at || nowIso();
    const attempt = transitionImageDispatchAttempt(
      attemptId,
      [DISPATCH_ATTEMPT_STATE.CONNECTING, DISPATCH_ATTEMPT_STATE.STREAMING],
      DISPATCH_ATTEMPT_STATE.STREAMING,
      {
        firstProgressAt: updates.firstProgressAt || at,
        lastProgressAt: updates.lastProgressAt || at,
      },
    );
    if (!attempt) return null;
    insertImageDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType:
        attempt.firstProgressAt === attempt.lastProgressAt
          ? DISPATCH_EVENT_TYPE.FIRST_PROGRESS
          : DISPATCH_EVENT_TYPE.LAST_PROGRESS,
      payload: { at },
    });
    return attempt;
  }

  async function completeAttempt(
    attemptId,
    { terminalReason = DEFAULT_TERMINAL_REASON.SUCCESS } = {},
  ) {
    const attempt = transitionImageDispatchAttempt(
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
    insertImageDispatchAttemptEvent({
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
    const attempt = transitionImageDispatchAttempt(
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
    insertImageDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType:
        nextState === DISPATCH_ATTEMPT_STATE.TIMED_OUT
          ? DISPATCH_EVENT_TYPE.TIMED_OUT
          : nextState === DISPATCH_ATTEMPT_STATE.CANCELLED
            ? DISPATCH_EVENT_TYPE.CANCELLED
            : DISPATCH_EVENT_TYPE.FAILED,
      payload: { terminalReason, timeoutKind, error },
    });
    return attempt;
  }

  async function getStatusSnapshot({ connectionViews = null } = {}) {
    const activeAttempts = await syncOccupancy();
    const connections = connectionViews || (await getConnections());
    const queuedRequests = listQueuedImageDispatchRequests(provider, 500);
    const capacity = {
      activeConnections: connections.length,
      capacityPerConnection: 1,
      totalCapacity: connections.length,
      activeLeases: activeAttempts.length,
      availableLeases: Math.max(0, connections.length - activeAttempts.length),
    };
    capacity.utilization =
      capacity.totalCapacity > 0
        ? capacity.activeLeases / capacity.totalCapacity
        : 0;

    return {
      provider,
      capacity,
      queuedRequests,
      activeAttempts,
      occupancyByConnection: { ...occupancyByConnection },
    };
  }

  function getInMemorySnapshot() {
    return {
      occupancyByConnection: { ...occupancyByConnection },
    };
  }

  return {
    enqueueRequest,
    tryLeaseAvailableWork,
    tryLeaseRequest,
    markAttemptConnecting,
    markAttemptStreamStarted,
    markAttemptProgress,
    completeAttempt,
    failAttempt,
    getStatusSnapshot,
    getInMemorySnapshot,
  };
}
