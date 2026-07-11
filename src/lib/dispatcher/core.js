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
import {
  createTimeoutPolicy,
  remainingQueueWaitMs,
} from "@/lib/dispatcher/timeoutPolicy.js";
import {
  DEFAULT_TERMINAL_REASON,
  DISPATCH_ATTEMPT_STATE,
  DISPATCH_EVENT_TYPE,
  DISPATCH_REQUEST_STATUS,
  DISPATCH_TIMEOUT_KIND,
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
  quotaHealth = dispatcherQuotaHealth,
} = {}) {
  if (typeof getConnections !== "function") {
    throw new Error("createDispatcherCore requires getConnections");
  }

  const policy = createTimeoutPolicy(timeoutPolicy);
  const occupancyByConnection = {};
  const leaseCountByConnection = {};
  // OPT-001: waiters resolve with a lease object when central refill assigns them
  const leaseWaiters = new Map(); // requestId -> { resolve, timer }
  // Leases assigned by refill before the request registered a waiter
  const pendingLeases = new Map(); // requestId -> lease
  let refillScheduled = false;
  let refillInFlight = false;
  let tryLeaseRequestCount = 0;
  let tryLeaseAvailableWorkCount = 0;
  function resolveWaiter(requestId, lease) {
    const waiter = leaseWaiters.get(requestId);
    if (!waiter) return false;
    leaseWaiters.delete(requestId);
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(lease);
    return true;
  }

  /**
   * Lease SQL already lands in `connecting` with connect_started_at. Keep this
   * as a no-op pass-through for callers / older LEASED rows.
   */
  function handOffLease(lease) {
    if (!lease?.attemptId) return lease;
    const existing = getDispatchAttempt(lease.attemptId);
    if (
      existing?.state === DISPATCH_ATTEMPT_STATE.CONNECTING &&
      existing.connectStartedAt
    ) {
      return {
        ...lease,
        attempt: existing,
        pathMode: existing.pathMode || lease.pathMode || null,
      };
    }
    if (existing?.state !== DISPATCH_ATTEMPT_STATE.LEASED) {
      return lease;
    }
    const pathMode = lease.pathMode || existing.pathMode || null;
    const updated = transitionDispatchAttempt(
      lease.attemptId,
      DISPATCH_ATTEMPT_STATE.LEASED,
      DISPATCH_ATTEMPT_STATE.CONNECTING,
      {
        connectStartedAt: nowIso(),
        pathMode,
      },
    );
    if (updated) {
      insertDispatchAttemptEvent({
        id: randomUUID(),
        attemptId: lease.attemptId,
        eventType: DISPATCH_EVENT_TYPE.CONNECT_STARTED,
        payload: { at: updated.connectStartedAt, source: "lease_handoff" },
      });
      return {
        ...lease,
        attempt: updated,
        pathMode: updated.pathMode || pathMode,
      };
    }
    return lease;
  }

  function claimPendingLease(requestId) {
    const lease = pendingLeases.get(requestId);
    if (!lease) return null;
    pendingLeases.delete(requestId);
    return handOffLease(lease);
  }

  /** Fail a LEASED/CONNECTING attempt that has no live consumer. */
  function abandonLeaseAttempt(attempt, reason = "lease_abandoned") {
    if (!attempt?.id) return false;
    if (
      attempt.state !== DISPATCH_ATTEMPT_STATE.LEASED &&
      attempt.state !== DISPATCH_ATTEMPT_STATE.CONNECTING
    ) {
      return false;
    }
    const failed = transitionDispatchAttempt(
      attempt.id,
      [
        DISPATCH_ATTEMPT_STATE.LEASED,
        DISPATCH_ATTEMPT_STATE.CONNECTING,
      ],
      DISPATCH_ATTEMPT_STATE.TIMED_OUT,
      {
        finishedAt: nowIso(),
        terminalReason: DEFAULT_TERMINAL_REASON.TIMEOUT,
        timeoutKind: DISPATCH_TIMEOUT_KIND.QUEUE_EXPIRED,
        error: {
          code: reason,
          message: "Lease had no live waiter/execute path",
        },
      },
    );
    if (!failed) return false;
    releaseConnectionOccupancy(attempt.connectionId);
    finalizeRequestForAttempt(failed, DISPATCH_ATTEMPT_STATE.TIMED_OUT);
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId: attempt.id,
      eventType: DISPATCH_EVENT_TYPE.TIMED_OUT,
      payload: {
        timeoutKind: DISPATCH_TIMEOUT_KIND.QUEUE_EXPIRED,
        reason,
      },
    });
    return true;
  }

  /**
   * Deliver lease to waiter. If nobody is waiting, do NOT park a LEASED ghost
   * (that was the connect_timeout source under concurrent load).
   */
  function deliverLease(requestId, lease) {
    if (!lease) return;
    if (leaseWaiters.has(requestId)) {
      resolveWaiter(requestId, handOffLease(lease));
      return;
    }
    // Race: waiter registered after plan but left before deliver — free slot.
    const attempt =
      (lease.attemptId && getDispatchAttempt(lease.attemptId)) ||
      lease.attempt ||
      null;
    if (attempt) {
      console.warn(
        `[DISPATCHER] ${provider}: dropping lease for ${requestId} — no waiter`,
      );
      abandonLeaseAttempt(attempt, "lease_no_waiter");
    }
  }

  /** Release a LEASED/CONNECTING attempt left without a consumer (wait timed out). */
  function releaseAbandonedLease(requestId) {
    const parked = pendingLeases.get(requestId);
    if (parked) pendingLeases.delete(requestId);
    const attempt =
      (parked?.attemptId && getDispatchAttempt(parked.attemptId)) ||
      getLatestDispatchAttemptForRequest(requestId);
    abandonLeaseAttempt(attempt, "lease_abandoned");
  }

  function notifyLeaseWaiters(requestId = null) {
    // Wake signal for any waiter that is still using waitForLeaseSignal fallback
    if (requestId) {
      const waiter = leaseWaiters.get(requestId);
      if (waiter && waiter.mode === "signal") {
        resolveWaiter(requestId, null);
      }
      return;
    }
    for (const [id, waiter] of [...leaseWaiters.entries()]) {
      if (waiter.mode === "signal") resolveWaiter(id, null);
    }
  }

  function scheduleRefill() {
    // Only schedule when someone is waiting for assignment. Eager refill on
    // enqueue would pre-lease work and break tryLeaseRequest call sites.
    if (leaseWaiters.size === 0) return;
    if (refillScheduled) return;
    refillScheduled = true;
    queueMicrotask(() => {
      refillScheduled = false;
      runRefill().catch((error) => {
        console.error("[DISPATCHER] refill failed:", error);
      });
    });
  }

  async function runRefill() {
    if (refillInFlight) {
      // Coalesce one more pass after the in-flight refill finishes
      queueMicrotask(() => scheduleRefill());
      return;
    }
    if (leaseWaiters.size === 0) return;
    refillInFlight = true;
    try {
      const leases = await tryLeaseAvailableWork();
      for (const lease of leases) {
        deliverLease(lease.requestId, lease);
      }
      // Continuous gate: only re-enter when we actually filled a gate and more
      // waiters remain. Re-scheduling when slots are full busy-loops microtasks
      // and starves waiting_limit timers (queued work never times out / progresses).
      if (leases.length > 0 && leaseWaiters.size > 0) {
        scheduleRefill();
      }
    } finally {
      refillInFlight = false;
    }
  }

  /**
   * Continuous gate model:
   * - Slots = gates. Vacant gate → next queued request immediately.
   * - On finish → notify vacancy → refill assigns next waiter (not batch-oriented).
   * - waiting_limit (queueTtlMs / 5 min) counted from queue arrival, not from wait() call.
   */
  async function waitForAssignedLease(requestId, timeoutMs) {
    // waiting_limit from queue arrival (attempt.queueEnteredAt / request.queuedAt)
    const attempt = getLatestDispatchAttemptForRequest(requestId);
    const request = getDispatchRequest(requestId);
    const queueEnteredAt =
      attempt?.queueEnteredAt || request?.queuedAt || null;
    const remainingMs = remainingQueueWaitMs(
      queueEnteredAt,
      {
        waitingLimitMs:
          Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
            ? Number(timeoutMs)
            : policy.waitingLimitMs,
      },
      Date.now(),
    );

    if (remainingMs <= 0) {
      console.warn(
        `[DISPATCHER] ${provider}: request ${requestId} exceeded waiting_limit (${policy.waitingLimitMs}ms) while queued`,
      );
      return null;
    }

    // Fail fast when the pool has zero eligible connections
    try {
      const connections = await getConnections();
      if (!Array.isArray(connections) || connections.length === 0) {
        console.warn(
          `[DISPATCHER] ${provider}: no active connections available for lease (check collection filter / isActive)`,
        );
        return null;
      }
    } catch (error) {
      console.error(`[DISPATCHER] ${provider}: getConnections failed:`, error);
      return null;
    }

    const parked = claimPendingLease(requestId);
    if (parked) return parked;

    // Free-slot fast path — one attempt, not a poll loop
    try {
      const immediate = await tryLeaseRequest(requestId);
      if (immediate) return immediate;
    } catch (error) {
      console.error(`[DISPATCHER] ${provider}: immediate lease failed:`, error);
    }

    // Refill may have parked a lease between tryLease and waiter registration
    const parkedAfterTry = claimPendingLease(requestId);
    if (parkedAfterTry) return parkedAfterTry;

    return new Promise((resolve) => {
      if (leaseWaiters.has(requestId)) {
        const prev = leaseWaiters.get(requestId);
        if (prev?.timer) clearTimeout(prev.timer);
      }
      const timer = setTimeout(() => {
        leaseWaiters.delete(requestId);
        // Free any LEASED attempt that was parked or assigned without a consumer
        releaseAbandonedLease(requestId);
        console.warn(
          `[DISPATCHER] ${provider}: request ${requestId} waiting_limit elapsed (queue wait)`,
        );
        resolve(null);
      }, remainingMs);
      // Do NOT unref — waiting_limit must keep the event loop alive until timeout
      // or lease delivery. unref caused queued waits to never fire under load.
      leaseWaiters.set(requestId, { resolve, timer, mode: "lease" });

      // Race: lease parked after we decided to wait but before map insert
      const raced = claimPendingLease(requestId);
      if (raced) {
        resolveWaiter(requestId, raced);
        return;
      }
      // Continuous gate: try to fill this waiter from any vacant slot now
      scheduleRefill();
    });
  }

  /** Legacy signal-only wait (tests / fallback) */
  function waitForLeaseSignal(requestId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        leaseWaiters.delete(requestId);
        resolve();
      }, Math.max(50, Math.min(Number(timeoutMs) || 500, 1000)));
      timer.unref?.();
      leaseWaiters.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        timer,
        mode: "signal",
      });
      scheduleRefill();
    });
  }

  function getLeaseMetrics() {
    return {
      tryLeaseRequestCount,
      tryLeaseAvailableWorkCount,
      waiterCount: leaseWaiters.size,
    };
  }

  function resetLeaseMetrics() {
    tryLeaseRequestCount = 0;
    tryLeaseAvailableWorkCount = 0;
  }

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

    // Waiters register via waitForAssignedLease after enqueue; they schedule refill.
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

    // If a waiter is already registered for this request, refill now
    scheduleRefill();
    return { request, attempt };
  }

  /**
   * OPT-002: eligibility uses precomputed affinity + request maps when provided.
   * Falls back to store lookups only when maps are omitted (tryLeaseRequest hot path).
   */
  function requestIsEligibleForConnection(
    request,
    connectionId,
    activeAttempts,
    affinityByKey = null,
    requestById = null,
  ) {
    const conversationKey = request?.conversationKey;
    if (!conversationKey) return true;
    const apiKeyScope =
      request?.metadata?.admission?.apiKeyScope || "__no_key__";
    const affinityKey = `${conversationKey}::${apiKeyScope}`;

    const affinity = affinityByKey
      ? affinityByKey.get(affinityKey)
      : getDispatchConversationAffinity(conversationKey, apiKeyScope);
    if (
      affinity &&
      affinity.connectionId &&
      affinity.connectionId !== connectionId
    ) {
      return false;
    }

    return !activeAttempts.some((attempt) => {
      if (attempt.requestId === request.id) return true;
      if (!request.conversationKey || attempt.connectionId === connectionId) {
        return false;
      }
      const other =
        requestById?.get(attempt.requestId) ||
        getDispatchRequest(attempt.requestId);
      if (!other) return false;
      if (other.conversationKey !== request.conversationKey) return false;
      const otherScope =
        other?.metadata?.admission?.apiKeyScope || "__no_key__";
      return otherScope === apiKeyScope;
    });
  }

  function buildPlanningContext(queuedRequests, activeAttempts) {
    const requestById = new Map();
    const affinityByKey = new Map();
    for (const req of queuedRequests) {
      requestById.set(req.id, req);
      const conversationKey = req?.conversationKey;
      if (!conversationKey) continue;
      const apiKeyScope =
        req?.metadata?.admission?.apiKeyScope || "__no_key__";
      const affinityKey = `${conversationKey}::${apiKeyScope}`;
      if (!affinityByKey.has(affinityKey)) {
        affinityByKey.set(
          affinityKey,
          getDispatchConversationAffinity(conversationKey, apiKeyScope),
        );
      }
    }
    for (const attempt of activeAttempts) {
      if (requestById.has(attempt.requestId)) continue;
      const req = getDispatchRequest(attempt.requestId);
      if (req) requestById.set(attempt.requestId, req);
    }
    return { requestById, affinityByKey };
  }

  function connectionCanServeRequest(connection, request) {
    const rawConnection = connection?._connection || connection;
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
    const plannedOccupancy = {};
    const slots = resolveSlotsPerConnection();
    const { requestById, affinityByKey } = buildPlanningContext(
      queuedRequests,
      activeAttempts,
    );

    for (const queuedRequest of queuedRequests) {
      if (leasedRequestIds.has(queuedRequest.id)) continue;

      const connection = getSortedConnectionsForRequest(
        connections,
        queuedRequest,
      ).find((candidateConnection) => {
        const currentOccupancy =
          (occupancyByConnection[candidateConnection.id] || 0) +
          (plannedOccupancy[candidateConnection.id] || 0);
        if (currentOccupancy >= slots) return false;
        return (
          connectionCanServeRequest(candidateConnection, queuedRequest) &&
          requestIsEligibleForConnection(
            queuedRequest,
            candidateConnection.id,
            activeAttempts,
            affinityByKey,
            requestById,
          )
        );
      });
      if (!connection) continue;

      leasedRequestIds.add(queuedRequest.id);
      plannedOccupancy[connection.id] =
        (plannedOccupancy[connection.id] || 0) + 1;
      leasePlan.push({
        requestId: queuedRequest.id,
        connection,
        attempt: getLatestDispatchAttemptForRequest(queuedRequest.id),
      });
    }

    return leasePlan;
  }

  async function tryLeaseAvailableWork() {
    tryLeaseAvailableWorkCount += 1;
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
      const attempt =
        plannedLease.attempt?.state === DISPATCH_ATTEMPT_STATE.QUEUED
          ? plannedLease.attempt
          : getLatestDispatchAttemptForRequest(request.id);
      if (!attempt || attempt.state !== DISPATCH_ATTEMPT_STATE.QUEUED) {
        continue;
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
        pathMode,
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

      leases.push({
        requestId: request.id,
        attemptId: leased.id,
        connectionId: connection.id,
        connection,
        request,
        attempt: leased,
        pathMode,
      });
    }

    return leases;
  }

  /**
   * origin/main-style single-request lease. Called in a poll loop by
   * executeCodexAttempt.waitForLease — keep this path simple and reliable.
   */
  async function tryLeaseRequest(requestId) {
    tryLeaseRequestCount += 1;
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

    const connection = getSortedConnectionsForRequest(
      connections,
      targetRequest,
    ).find((candidateConnection) => {
      const currentOccupancy =
        occupancyByConnection[candidateConnection.id] || 0;
      if (currentOccupancy >= resolveSlotsPerConnection()) return false;
      return (
        connectionCanServeRequest(candidateConnection, targetRequest) &&
        requestIsEligibleForConnection(
          targetRequest,
          candidateConnection.id,
          activeAttempts,
        )
      );
    });
    if (!connection) return null;

    const attempt = getLatestDispatchAttemptForRequest(requestId);
    if (!attempt || attempt.state !== DISPATCH_ATTEMPT_STATE.QUEUED) return null;

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
      pathMode,
    });
    if (!leased) return null;

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

    // Close pure-LEASED window immediately: connect_timeout is 30s and was
    // killing rows that never reached execute markConnect under concurrency.
    const connecting =
      transitionDispatchAttempt(
        leased.id,
        DISPATCH_ATTEMPT_STATE.LEASED,
        DISPATCH_ATTEMPT_STATE.CONNECTING,
        {
          connectStartedAt: nowIso(),
          pathMode,
        },
      ) || leased;
    if (connecting.state === DISPATCH_ATTEMPT_STATE.CONNECTING) {
      insertDispatchAttemptEvent({
        id: randomUUID(),
        attemptId: leased.id,
        eventType: DISPATCH_EVENT_TYPE.CONNECT_STARTED,
        payload: { at: connecting.connectStartedAt, source: "try_lease" },
      });
    }

    return {
      requestId,
      attemptId: leased.id,
      connectionId: connection.id,
      connection,
      request: targetRequest,
      attempt: connecting,
      pathMode,
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
    const existing = getDispatchAttempt(attemptId);
    if (
      existing?.state === DISPATCH_ATTEMPT_STATE.CONNECTING &&
      existing.connectStartedAt
    ) {
      return existing;
    }
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
    // Only seed firstProgressAt when still empty — COALESCE overwrites if we
    // keep passing a new firstProgressAt on every heartbeat.
    const existing = getDispatchAttempt(attemptId);
    if (!existing) return null;
    const isFirst = !existing.firstProgressAt;
    const progress = transitionDispatchAttempt(
      attemptId,
      [DISPATCH_ATTEMPT_STATE.CONNECTING, DISPATCH_ATTEMPT_STATE.STREAMING],
      DISPATCH_ATTEMPT_STATE.STREAMING,
      {
        firstProgressAt: isFirst ? updates.firstProgressAt || at : null,
        lastProgressAt: updates.lastProgressAt || at,
      },
    );
    if (!progress) return null;
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType: isFirst
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

    // Gate vacated — immediately pull next queued task (continuous, not batch)
    releaseConnectionOccupancy(attempt.connectionId);
    finalizeRequestForAttempt(attempt, DISPATCH_ATTEMPT_STATE.COMPLETED);
    insertDispatchAttemptEvent({
      id: randomUUID(),
      attemptId,
      eventType: DISPATCH_EVENT_TYPE.COMPLETED,
      payload: { terminalReason },
    });
    scheduleRefill();
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
            : nextState === DISPATCH_ATTEMPT_STATE.RECONCILED
              ? DISPATCH_EVENT_TYPE.RECONCILED
              : DISPATCH_EVENT_TYPE.FAILED,
      payload: {
        terminalReason,
        timeoutKind,
        error,
      },
    });
    scheduleRefill();
    return attempt;
  }

  function getInMemorySnapshot() {
    return {
      occupancyByConnection: { ...occupancyByConnection },
      leaseCountByConnection: { ...leaseCountByConnection },
      timeoutPolicy: { ...policy },
      pathHealth: pathHealth.snapshot(),
      leaseMetrics: getLeaseMetrics(),
    };
  }

  return {
    provider,
    enqueueRequest,
    requeueRequest,
    tryLeaseAvailableWork,
    tryLeaseRequest,
    waitForAssignedLease,
    waitForLeaseSignal,
    scheduleRefill,
    notifyLeaseWaiters,
    getLeaseMetrics,
    resetLeaseMetrics,
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
