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
import {
  createPathHealthTracker,
  resolvePathMode,
} from "@/lib/dispatcher/pathHealth.js";
import { dispatcherQuotaHealth } from "@/lib/dispatcher/quotaHealth.js";
import { createTimeoutPolicy } from "@/lib/dispatcher/timeoutPolicy.js";
import {
  DEFAULT_TERMINAL_REASON,
  DISPATCH_ATTEMPT_STATE,
  DISPATCH_EVENT_TYPE,
  DISPATCH_REQUEST_STATUS,
} from "@/lib/dispatcher/types.js";
import { isCachePrefixKey } from "@/lib/dispatcher/conversationAffinity.js";
import {
  MAX_QUEUED_PER_PROVIDER,
  PRIORITY_CLASS,
  batchSlotCeiling,
  priorityClassOf,
} from "@/lib/dispatcher/priorityQueue.js";
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

export const STARVATION_AGE_MS = 30_000;
// A queued request that has neither arrived nor polled within this long is
// not waiting any more (its client left or its process died), so it holds
// nobody back.
const WAITER_STALE_MS = 2_000;

// Last poll per queued request, shared across module copies like the slot map.
function waiterSeenAt() {
  globalThis.__dispatcherWaiterSeenAt ??= new Map();
  return globalThis.__dispatcherWaiterSeenAt;
}

function forgetStaleWaiters(now) {
  const seen = waiterSeenAt();
  if (seen.size < 1000) return;
  for (const [requestId, at] of seen) {
    if (now - at > 60_000) seen.delete(requestId);
  }
}

/**
 * Rank of a queued request: interactive above batch; within a class,
 * continuations and requests waiting longer than STARVATION_AGE_MS above
 * fresh first turns. Requests of equal rank are not ordered among themselves.
 */
export function requestRank(request, now = Date.now()) {
  const classRank = priorityClassOf(request) === PRIORITY_CLASS.INTERACTIVE ? 2 : 0;
  const age = now - new Date(request?.queuedAt || now).getTime();
  const tier = request?.metadata?.isContinuation || age >= STARVATION_AGE_MS ? 1 : 0;
  return classRank + tier;
}

/** Queue order for display and sweeps: higher rank first, then first come. */
export function sortRequestsByPriorityAndQueueTime(requests, now = Date.now()) {
  return [...requests].sort(
    (a, b) =>
      requestRank(b, now) - requestRank(a, now) ||
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

  function readActiveAttempts() {
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
    connections,
  ) {
    const excluded = request?.metadata?.excludedConnectionIds || [];
    if (Array.isArray(excluded) && excluded.includes(connectionId)) {
      return false;
    }

    const conversationKey = request?.conversationKey;
    if (!conversationKey) return true;

    // Soft prompt-cache affinity does NOT enforce hard mutual exclusion across pool accounts.
    if (isCachePrefixKey(conversationKey)) {
      return true;
    }

    const apiKeyScope =
      request?.metadata?.admission?.apiKeyScope || "__no_key__";

    const affinity = getDispatchConversationAffinity(
      conversationKey,
      apiKeyScope,
      provider,
    );
    if (
      affinity &&
      affinity.connectionId &&
      (!affinity.provider || affinity.provider === provider)
    ) {
      const pinned = connections.find(
        (connection) => connection.id === affinity.connectionId,
      );
      if (Array.isArray(excluded) && excluded.includes(affinity.connectionId)) {
        // Sticky target previously failed on this request: allow failover to alternative connection
      } else if (!pinned || !connectionCanServeRequest(pinned, request)) {
        // Sticky target is gone, disabled, locked or out of quota: waiting for
        // it would strand the conversation, so let any account serve it.
      } else if (affinity.connectionId !== connectionId) {
        return false;
      }
    }

    return !activeAttempts.some(
      (attempt) =>
        attempt.requestId === request.id ||
        (request.conversationKey &&
          getDispatchRequest(attempt.requestId)?.conversationKey ===
            request.conversationKey &&
          getDispatchRequest(attempt.requestId)?.provider === provider &&
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

  function getSortedConnectionsForRequest(connections, request) {
    const conversationKey = request?.conversationKey;
    const apiKeyScope =
      request?.metadata?.admission?.apiKeyScope || "__no_key__";
    const affinity = conversationKey
      ? getDispatchConversationAffinity(conversationKey, apiKeyScope, provider)
      : null;
    const preferredConnectionId =
      affinity && (!affinity.provider || affinity.provider === provider)
        ? affinity.connectionId
        : null;

    return [...connections]
      .filter((connection) => connection?.id)
      .sort((a, b) => {
        // 1. Least-connections: lower occupancy strictly wins.
        const occA = occupancyByConnection[a.id] || 0;
        const occB = occupancyByConnection[b.id] || 0;
        const occupancyDiff = occA - occB;
        if (occupancyDiff !== 0) return occupancyDiff;

        // 2. Session Warmth: on equal occupancy, connection with warm KV cache wins.
        if (preferredConnectionId) {
          if (a.id === preferredConnectionId && b.id !== preferredConnectionId) return -1;
          if (b.id === preferredConnectionId && a.id !== preferredConnectionId) return 1;
        }

        // 3. Quota health penalty.
        const quotaPenaltyDiff =
          quotaHealth.getSelectionPenalty(a, request) -
          quotaHealth.getSelectionPenalty(b, request);
        if (quotaPenaltyDiff !== 0) return quotaPenaltyDiff;

        // 4. Cumulative lease balancing for non-session traffic.
        const leaseCountDiff =
          (leaseCountByConnection[a.id] || 0) -
          (leaseCountByConnection[b.id] || 0);
        if (leaseCountDiff !== 0) return leaseCountDiff;

        // 5. Path health score.
        const pathScoreDiff =
          pathHealth.rankConnection(b, occB) -
          pathHealth.rankConnection(a, occA);
        if (pathScoreDiff !== 0) return pathScoreDiff;

        // 6. Configured priority and deterministic ID tie-break.
        return compareConnections(a, b);
      });
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
    const connections = await getConnections();
    // Read active attempts only after the last await: from here to the lease
    // write everything is synchronous, so a concurrent lease of the same
    // conversation is always visible and the two cannot split across accounts.
    const activeAttempts = readActiveAttempts();

    // Reclaim first: already-admitted attempts are not in the queued list.
    const reclaimed = reclaimActiveLease(requestId, connections);
    if (reclaimed) return reclaimed;

    const now = Date.now();
    waiterSeenAt().set(requestId, now);
    forgetStaleWaiters(now);

    const queuedRequests = listQueuedDispatchRequests(
      provider,
      MAX_QUEUED_PER_PROVIDER,
    );
    const targetRequest = queuedRequests.find(
      (request) => request.id === requestId,
    );
    if (!targetRequest) return null;

    const slots = resolveSlotsPerConnection();
    const batchCeiling = batchSlotCeiling(slots * connections.length);
    const activeBatchCount = activeAttempts.filter(
      (attempt) =>
        priorityClassOf(getDispatchRequest(attempt.requestId)) ===
        PRIORITY_CLASS.BATCH,
    ).length;

    // The account this request would run on now, or null when it cannot run:
    // no free slot it may use, or batch work already holds its share.
    const connectionFor = (request) => {
      if (
        priorityClassOf(request) === PRIORITY_CLASS.BATCH &&
        activeBatchCount >= batchCeiling
      ) {
        return null;
      }
      return (
        getSortedConnectionsForRequest(connections, request).find(
          (candidateConnection) =>
            (occupancyByConnection[candidateConnection.id] || 0) < slots &&
            connectionCanServeRequest(candidateConnection, request) &&
            requestIsEligibleForConnection(
              request,
              candidateConnection.id,
              activeAttempts,
              connections,
            ),
        ) || null
      );
    };

    const connection = connectionFor(targetRequest);
    if (!connection) return null;

    // Step aside for a higher-ranked request that is still waiting and could
    // run now. One that cannot run anywhere (its accounts are locked, or batch
    // is at its share) holds nobody back.
    const seen = waiterSeenAt();
    const targetRank = requestRank(targetRequest, now);
    const higherCanRun = queuedRequests.some(
      (other) =>
        requestRank(other, now) > targetRank &&
        now - Math.max(seen.get(other.id) || 0, Date.parse(other.queuedAt) || 0) <=
          WAITER_STALE_MS &&
        connectionFor(other) !== null,
    );
    if (higherCanRun) return null;

    const attempt = getLatestDispatchAttemptForRequest(requestId);
    if (!attempt || attempt.state !== DISPATCH_ATTEMPT_STATE.QUEUED) {
      // Race: another poll admitted between queue snapshot and lease write.
      return reclaimActiveLease(requestId, connections);
    }

    const leasedAt = nowIso();
    const leaseKey = buildLeaseKey(connection.id);
    const pathMode = resolvePathMode(connection);
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
    waiterSeenAt().delete(requestId);
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

  // Only attempts that reached a connection have a path to score. A timeout
  // after the lease is the one failure that says the route itself is bad;
  // provider errors and client disconnects say nothing about the route.
  function recordPathOutcomeForAttempt(attempt, outcome) {
    if (!attempt.connectionId || !attempt.pathMode) return;
    pathHealth.recordPathOutcome(attempt.connectionId, attempt.pathMode, outcome);
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
    recordPathOutcomeForAttempt(attempt, "success");
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
    if (nextState === DISPATCH_ATTEMPT_STATE.TIMED_OUT) {
      recordPathOutcomeForAttempt(attempt, "failed");
    }
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
