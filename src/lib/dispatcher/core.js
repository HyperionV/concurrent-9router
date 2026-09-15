import { randomUUID } from "node:crypto";
import {
  getDispatchAttempt,
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
import { dispatcherQuotaHealth } from "@/lib/dispatcher/quotaHealth.js";
import { createTimeoutPolicy } from "@/lib/dispatcher/timeoutPolicy.js";
import {
  DEFAULT_TERMINAL_REASON,
  DISPATCH_ATTEMPT_STATE,
  DISPATCH_EVENT_TYPE,
  DISPATCH_REQUEST_STATUS,
} from "@/lib/dispatcher/types.js";
import { isModelLockActive } from "open-sse/services/accountFallback.js";
import { isConnectionRateLimitDisabled } from "@/lib/connectionHealth.js";
import { dispatcherMetricsAggregator } from "@/lib/dispatcher/metricsAggregator.js";

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
  quotaHealth = dispatcherQuotaHealth,
} = {}) {
  if (typeof getConnections !== "function") {
    throw new Error("createDispatcherCore requires getConnections");
  }

  const policy = createTimeoutPolicy(timeoutPolicy);
  const occupancyByConnection = {};
  const leaseCountByConnection = {};

  function resolveSlotsPerConnection() {
    // Prefer process-global slot map written by loadProviderConnections so
    // multiple webpack module copies see the same codex slot count (e.g. 8).
    const shared = globalThis.__dispatcherSlotsByProvider?.[provider];
    if (Number.isFinite(Number(shared)) && Number(shared) > 0) {
      return Number(shared);
    }
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
      leaseCountByConnection[attempt.connectionId] = Math.max(
        leaseCountByConnection[attempt.connectionId] || 0,
        occupancyByConnection[attempt.connectionId],
      );
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
    const apiKeyScope =
      request?.metadata?.admission?.apiKeyScope || "__no_key__";

    const affinity = getDispatchConversationAffinity(
      conversationKey,
      apiKeyScope,
    );
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
          (getDispatchRequest(attempt.requestId)?.metadata?.admission
            ?.apiKeyScope || "__no_key__") === apiKeyScope &&
          attempt.connectionId !== connectionId),
    );
  }

  function connectionCanServeRequest(connection, request) {
    const rawConnection = connection?._connection || connection;
    if (isConnectionRateLimitDisabled(rawConnection)) return false;
    return (
      !isModelLockActive(rawConnection, request?.modelId || null) &&
      quotaHealth.canServeRequest(rawConnection, request)
    );
  }

  function getSortedConnections(connections) {
    return getSortedConnectionsForRequest(connections, null);
  }

  function getSortedConnectionsForRequest(connections, request) {
    return [...connections]
      .filter((connection) => connection?.id)
      .sort((a, b) => {
        const occupancyDiff =
          (occupancyByConnection[a.id] || 0) -
          (occupancyByConnection[b.id] || 0);
        if (occupancyDiff !== 0) return occupancyDiff;
        const leaseCountDiff =
          (leaseCountByConnection[a.id] || 0) -
          (leaseCountByConnection[b.id] || 0);
        if (leaseCountDiff !== 0) return leaseCountDiff;
        const quotaPenaltyDiff =
          quotaHealth.getSelectionPenalty(a, request) -
          quotaHealth.getSelectionPenalty(b, request);
        if (quotaPenaltyDiff !== 0) return quotaPenaltyDiff;
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

    for (const queuedRequest of queuedRequests) {
      if (leasedRequestIds.has(queuedRequest.id)) continue;

      const connection = getSortedConnectionsForRequest(
        connections,
        queuedRequest,
      ).find((candidateConnection) => {
        const currentOccupancy =
          (occupancyByConnection[candidateConnection.id] || 0) +
          leasePlan.filter(
            (plannedLease) =>
              plannedLease.connection.id === candidateConnection.id,
          ).length;
        if (currentOccupancy >= resolveSlotsPerConnection()) return false;
        return (
          connectionCanServeRequest(candidateConnection, queuedRequest) &&
          requestIsEligibleForConnection(
            queuedRequest,
            candidateConnection.id,
            activeAttempts,
          )
        );
      });
      if (!connection) continue;

      leasedRequestIds.add(queuedRequest.id);
      leasePlan.push({ requestId: queuedRequest.id, connection });
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
      leaseCountByConnection[connection.id] =
        (leaseCountByConnection[connection.id] || 0) + 1;

      insertDispatchAttemptEvent({
        id: randomUUID(),
        attemptId: leased.id,
        eventType: DISPATCH_EVENT_TYPE.LEASED,
        payload: {
          connectionId: connection.id,
          leaseKey,
        },
      });
      insertDispatchAttemptEvent({
        id: randomUUID(),
        attemptId: leased.id,
        eventType: DISPATCH_EVENT_TYPE.CONNECT_STARTED,
        payload: {
          at: leased.connectStartedAt || leasedAt,
          source: "try_lease_available",
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

  /**
   * If SQLite already admitted this request (leased/connecting) but the HTTP
   * waiter never got the return value, hand the lease back. Without this,
   * request status is RUNNING so listQueued misses it, polls return null, and
   * the pure-leased row dies at connect_timeout (01:08 ledger: LEASED event,
   * no connect_started, no LEASE_OK).
   */
  function buildLeaseResult(requestId, attempt, connection, extra = {}) {
    const request = getDispatchRequest(requestId);
    if (!request || !attempt?.connectionId) return null;
    const resolvedConnection =
      connection ||
      (attempt.connectionId
        ? { id: attempt.connectionId, providerSpecificData: {} }
        : null);
    if (!resolvedConnection) return null;
    return {
      requestId,
      attemptId: attempt.id,
      connectionId: attempt.connectionId,
      connection: resolvedConnection,
      request,
      attempt,
      pathMode: attempt.pathMode || extra.pathMode || null,
      ...extra,
    };
  }

  function reclaimActiveLease(requestId, connections) {
    const existing = getLatestDispatchAttemptForRequest(requestId);
    if (
      !existing?.connectionId ||
      (existing.state !== DISPATCH_ATTEMPT_STATE.LEASED &&
        existing.state !== DISPATCH_ATTEMPT_STATE.CONNECTING)
    ) {
      return null;
    }

    let attempt = existing;
    // Heal pure-leased ghosts so connect_timeout cannot fire while the
    // waiter is still polling (origin/main advances via markConnecting).
    if (
      existing.state === DISPATCH_ATTEMPT_STATE.LEASED ||
      !existing.connectStartedAt
    ) {
      const healed = transitionDispatchAttempt(
        existing.id,
        [DISPATCH_ATTEMPT_STATE.LEASED, DISPATCH_ATTEMPT_STATE.CONNECTING],
        DISPATCH_ATTEMPT_STATE.CONNECTING,
        {
          connectStartedAt: existing.connectStartedAt || nowIso(),
        },
      );
      if (healed) {
        attempt = healed;
        insertDispatchAttemptEvent({
          id: randomUUID(),
          attemptId: attempt.id,
          eventType: DISPATCH_EVENT_TYPE.CONNECT_STARTED,
          payload: {
            at: attempt.connectStartedAt,
            source: "try_lease_reclaim",
          },
        });
      }
    }

    const connection =
      (connections || []).find((c) => c.id === attempt.connectionId) || null;
    return buildLeaseResult(requestId, attempt, connection, {
      reclaimed: true,
    });
  }

  async function tryLeaseRequest(requestId) {
    // Occupancy is rebuilt from SQLite each call (source of truth across
    // webpack module copies). Do not use a process-global async lock here —
    // it deadlocked all concurrent admits (5× waiting, 0× LEASE_OK).
    const [connections, activeAttempts] = await Promise.all([
      getConnections(),
      syncOccupancy(),
    ]);

    // Reclaim first: already-admitted attempts are not in the queued list.
    const reclaimed = reclaimActiveLease(requestId, connections);
    if (reclaimed) return reclaimed;

    const slots = resolveSlotsPerConnection();
    const queuedRequests = sortRequestsByQueueTime(
      listQueuedDispatchRequests(provider, 500),
    );
    const targetRequest = queuedRequests.find(
      (request) => request.id === requestId,
    );
    if (!targetRequest) return null;

    const connection = getSortedConnectionsForRequest(
      connections,
      targetRequest,
    ).find((candidateConnection) => {
      const currentOccupancy =
        occupancyByConnection[candidateConnection.id] || 0;
      if (currentOccupancy >= slots) return false;
      return (
        connectionCanServeRequest(candidateConnection, targetRequest) &&
        requestIsEligibleForConnection(
          targetRequest,
          candidateConnection.id,
          activeAttempts,
        )
      );
    });
    if (!connection) {
      if (connections.length === 0) {
        console.warn(
          `[DISPATCHER] ${provider}: tryLease null — zero connections (check collection filter / isActive)`,
        );
      }
      return null;
    }

    const attempt = getLatestDispatchAttemptForRequest(requestId);
    if (!attempt || attempt.state !== DISPATCH_ATTEMPT_STATE.QUEUED) {
      // Race: another poll admitted between queue snapshot and lease write.
      return reclaimActiveLease(requestId, connections);
    }

    const leasedAt = nowIso();
    const leaseKey = buildLeaseKey(connection.id);
    const pathMode = connection?.providerSpecificData?.vercelRelayUrl
      ? "vercel-relay"
      : connection?.providerSpecificData?.connectionProxyEnabled
        ? "connection-proxy"
        : "direct";
    const leased = leaseDispatchAttempt(attempt.id, {
      connectionId: connection.id,
      leaseKey,
      leasedAt,
      connectStartedAt: leasedAt,
      pathMode,
    });
    if (!leased) {
      // Lost the atomic race — reclaim the winner's admission.
      return reclaimActiveLease(requestId, connections);
    }

    updateDispatchRequestStatus(requestId, DISPATCH_REQUEST_STATUS.RUNNING);
    occupancyByConnection[connection.id] =
      (occupancyByConnection[connection.id] || 0) + 1;
    leaseCountByConnection[connection.id] =
      (leaseCountByConnection[connection.id] || 0) + 1;

    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId: leased.id,
      eventType: DISPATCH_EVENT_TYPE.LEASED,
      payload: {
        connectionId: connection.id,
        leaseKey,
      },
    });
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId: leased.id,
      eventType: DISPATCH_EVENT_TYPE.CONNECT_STARTED,
      payload: {
        at: leased.connectStartedAt || leasedAt,
        source: "try_lease_request",
      },
    });

    return buildLeaseResult(requestId, leased, connection, { pathMode });
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
    const existing = getDispatchAttempt(attemptId);
    if (
      existing?.state === DISPATCH_ATTEMPT_STATE.CONNECTING &&
      existing.connectStartedAt
    ) {
      return existing;
    }
    return markAttemptState(
      attemptId,
      [DISPATCH_ATTEMPT_STATE.LEASED, DISPATCH_ATTEMPT_STATE.CONNECTING],
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

    dispatcherMetricsAggregator.recordAttemptCompletion(attempt);
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

    dispatcherMetricsAggregator.recordAttemptCompletion(attempt);
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
      leaseCountByConnection: { ...leaseCountByConnection },
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
