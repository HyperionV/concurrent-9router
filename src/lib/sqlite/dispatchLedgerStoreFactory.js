import { getSqlite } from "@/lib/sqlite/runtime.js";
import { nowIso, parseJson, stringifyJson } from "@/lib/sqlite/helpers.js";

function normalizeAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    requestId: row.request_id,
    attemptIndex: row.attempt_index,
    provider: row.provider,
    modelId: row.model_id,
    connectionId: row.connection_id,
    leaseKey: row.lease_key,
    state: row.state,
    pathMode: row.path_mode,
    queueEnteredAt: row.queue_entered_at,
    leasedAt: row.leased_at,
    connectStartedAt: row.connect_started_at,
    streamStartedAt: row.stream_started_at,
    firstProgressAt: row.first_progress_at,
    lastProgressAt: row.last_progress_at,
    finishedAt: row.finished_at,
    timeoutKind: row.timeout_kind,
    terminalReason: row.terminal_reason,
    error: parseJson(row.error_json, {}),
  };
}

function normalizeRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    modelId: row.model_id,
    sourceEndpoint: row.source_endpoint,
    sourceFormat: row.source_format,
    targetFormat: row.target_format,
    conversationKey: row.conversation_key,
    requestKind: row.request_kind,
    status: row.status,
    queuedAt: row.queued_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
    metadata: parseJson(row.metadata_json, {}),
  };
}

export function createDispatchLedgerStore({
  requestsTable,
  attemptsTable,
  eventsTable,
}) {
  if (!requestsTable || !attemptsTable || !eventsTable) {
    throw new Error("dispatch ledger store requires table names");
  }

  function insertRequest(record) {
    const db = getSqlite();
    const queuedAt = record.queuedAt || nowIso();
    db.prepare(
      `
        INSERT INTO ${requestsTable}(
          id, provider, model_id, source_endpoint, source_format, target_format,
          conversation_key, request_kind, status, queued_at, expires_at, completed_at, metadata_json
        ) VALUES (
          @id, @provider, @modelId, @sourceEndpoint, @sourceFormat, @targetFormat,
          @conversationKey, @requestKind, @status, @queuedAt, @expiresAt, @completedAt, @metadataJson
        )
      `,
    ).run({
      id: record.id,
      provider: record.provider,
      modelId: record.modelId,
      sourceEndpoint: record.sourceEndpoint || null,
      sourceFormat: record.sourceFormat || null,
      targetFormat: record.targetFormat || null,
      conversationKey: record.conversationKey || null,
      requestKind: record.requestKind || "chat",
      status: record.status || "queued",
      queuedAt,
      expiresAt: record.expiresAt || null,
      completedAt: record.completedAt || null,
      metadataJson: stringifyJson(record.metadata || {}),
    });
    return getRequest(record.id);
  }

  function getRequest(id) {
    const row = getSqlite()
      .prepare(`SELECT * FROM ${requestsTable} WHERE id = ?`)
      .get(id);
    return normalizeRequest(row);
  }

  function updateRequestStatus(id, status, updates = {}) {
    getSqlite()
      .prepare(
        `
          UPDATE ${requestsTable}
          SET status = @status,
              completed_at = COALESCE(@completedAt, completed_at),
              expires_at = COALESCE(@expiresAt, expires_at),
              metadata_json = @metadataJson
          WHERE id = @id
        `,
      )
      .run({
        id,
        status,
        completedAt: updates.completedAt || null,
        expiresAt: updates.expiresAt || null,
        metadataJson: stringifyJson(
          updates.metadata ?? getRequest(id)?.metadata ?? {},
        ),
      });
    return getRequest(id);
  }

  function listQueuedRequests(provider, limit = 100) {
    const rows = getSqlite()
      .prepare(
        `
          SELECT *
          FROM ${requestsTable}
          WHERE provider = ?
            AND status = 'queued'
          ORDER BY queued_at ASC
          LIMIT ?
        `,
      )
      .all(provider, limit);
    return rows.map(normalizeRequest);
  }

  function insertAttempt(record) {
    getSqlite()
      .prepare(
        `
          INSERT INTO ${attemptsTable}(
            id, request_id, attempt_index, provider, model_id, connection_id, lease_key,
            state, path_mode, queue_entered_at, leased_at, connect_started_at,
            stream_started_at, first_progress_at, last_progress_at, finished_at,
            timeout_kind, terminal_reason, error_json
          ) VALUES (
            @id, @requestId, @attemptIndex, @provider, @modelId, @connectionId, @leaseKey,
            @state, @pathMode, @queueEnteredAt, @leasedAt, @connectStartedAt,
            @streamStartedAt, @firstProgressAt, @lastProgressAt, @finishedAt,
            @timeoutKind, @terminalReason, @errorJson
          )
        `,
      )
      .run({
        id: record.id,
        requestId: record.requestId,
        attemptIndex: record.attemptIndex,
        provider: record.provider,
        modelId: record.modelId,
        connectionId: record.connectionId || null,
        leaseKey: record.leaseKey || null,
        state: record.state || "queued",
        pathMode: record.pathMode || null,
        queueEnteredAt: record.queueEnteredAt || nowIso(),
        leasedAt: record.leasedAt || null,
        connectStartedAt: record.connectStartedAt || null,
        streamStartedAt: record.streamStartedAt || null,
        firstProgressAt: record.firstProgressAt || null,
        lastProgressAt: record.lastProgressAt || null,
        finishedAt: record.finishedAt || null,
        timeoutKind: record.timeoutKind || null,
        terminalReason: record.terminalReason || null,
        errorJson: stringifyJson(record.error || {}),
      });
    return getAttempt(record.id);
  }

  function getAttempt(id) {
    const row = getSqlite()
      .prepare(`SELECT * FROM ${attemptsTable} WHERE id = ?`)
      .get(id);
    return normalizeAttempt(row);
  }

  function getLatestAttemptForRequest(requestId) {
    const row = getSqlite()
      .prepare(
        `
          SELECT *
          FROM ${attemptsTable}
          WHERE request_id = ?
          ORDER BY attempt_index DESC
          LIMIT 1
        `,
      )
      .get(requestId);
    return normalizeAttempt(row);
  }

  function listActiveAttempts(provider = null) {
    const sql = provider
      ? `
          SELECT *
          FROM ${attemptsTable}
          WHERE provider = ?
            AND state IN ('leased', 'connecting', 'streaming')
          ORDER BY queue_entered_at ASC
        `
      : `
          SELECT *
          FROM ${attemptsTable}
          WHERE state IN ('leased', 'connecting', 'streaming')
          ORDER BY queue_entered_at ASC
        `;
    const rows = provider
      ? getSqlite().prepare(sql).all(provider)
      : getSqlite().prepare(sql).all();
    return rows.map(normalizeAttempt);
  }

  function listAttemptsByState(states) {
    if (!Array.isArray(states) || states.length === 0) return [];
    const placeholders = states.map(() => "?").join(", ");
    const rows = getSqlite()
      .prepare(
        `
          SELECT *
          FROM ${attemptsTable}
          WHERE state IN (${placeholders})
          ORDER BY queue_entered_at ASC
        `,
      )
      .all(...states);
    return rows.map(normalizeAttempt);
  }

  function leaseAttempt(attemptId, lease) {
    const result = getSqlite()
      .prepare(
        `
          UPDATE ${attemptsTable}
          SET state = 'leased',
              connection_id = @connectionId,
              lease_key = @leaseKey,
              leased_at = @leasedAt,
              path_mode = @pathMode
          WHERE id = @attemptId
            AND state = 'queued'
        `,
      )
      .run({
        attemptId,
        connectionId: lease.connectionId,
        leaseKey: lease.leaseKey,
        leasedAt: lease.leasedAt || nowIso(),
        pathMode: lease.pathMode || null,
      });
    return result.changes === 1 ? getAttempt(attemptId) : null;
  }

  function transitionAttempt(attemptId, fromStates, nextState, updates = {}) {
    const states = Array.isArray(fromStates) ? fromStates : [fromStates];
    const placeholders = states.map(() => "?").join(", ");
    const errorJson = stringifyJson(updates.error || {});
    const result = getSqlite()
      .prepare(
        `
          UPDATE ${attemptsTable}
          SET state = ?,
              path_mode = COALESCE(?, path_mode),
              connect_started_at = COALESCE(?, connect_started_at),
              stream_started_at = COALESCE(?, stream_started_at),
              first_progress_at = COALESCE(?, first_progress_at),
              last_progress_at = COALESCE(?, last_progress_at),
              finished_at = COALESCE(?, finished_at),
              timeout_kind = COALESCE(?, timeout_kind),
              terminal_reason = COALESCE(?, terminal_reason),
              error_json = CASE WHEN ? = '{}' THEN error_json ELSE ? END
          WHERE id = ?
            AND state IN (${placeholders})
        `,
      )
      .run(
        nextState,
        updates.pathMode || null,
        updates.connectStartedAt || null,
        updates.streamStartedAt || null,
        updates.firstProgressAt || null,
        updates.lastProgressAt || null,
        updates.finishedAt || null,
        updates.timeoutKind || null,
        updates.terminalReason || null,
        errorJson,
        errorJson,
        attemptId,
        ...states,
      );
    return result.changes === 1 ? getAttempt(attemptId) : null;
  }

  function insertAttemptEvent(event) {
    getSqlite()
      .prepare(
        `
          INSERT INTO ${eventsTable}(id, attempt_id, event_type, at, payload_json)
          VALUES(@id, @attemptId, @eventType, @at, @payloadJson)
        `,
      )
      .run({
        id: event.id,
        attemptId: event.attemptId,
        eventType: event.eventType,
        at: event.at || nowIso(),
        payloadJson: stringifyJson(event.payload || {}),
      });
  }

  function listAttemptEvents(attemptId) {
    const rows = getSqlite()
      .prepare(
        `
          SELECT *
          FROM ${eventsTable}
          WHERE attempt_id = ?
          ORDER BY at ASC
        `,
      )
      .all(attemptId);
    return rows.map((row) => ({
      id: row.id,
      attemptId: row.attempt_id,
      eventType: row.event_type,
      at: row.at,
      payload: parseJson(row.payload_json, {}),
    }));
  }

  function clearTables() {
    const db = getSqlite();
    db.prepare(`DELETE FROM ${eventsTable}`).run();
    db.prepare(`DELETE FROM ${attemptsTable}`).run();
    db.prepare(`DELETE FROM ${requestsTable}`).run();
  }

  function pruneLedger({ retainAttemptsSince = null } = {}) {
    const result = {
      deletedEvents: 0,
      deletedAttempts: 0,
      deletedRequests: 0,
    };
    if (!retainAttemptsSince) return result;

    const db = getSqlite();
    result.deletedEvents =
      db
        .prepare(
          `
            DELETE FROM ${eventsTable}
            WHERE attempt_id IN (
              SELECT id
              FROM ${attemptsTable}
              WHERE COALESCE(finished_at, last_progress_at, first_progress_at, stream_started_at, connect_started_at, leased_at, queue_entered_at) < ?
                AND state IN ('completed', 'failed', 'timed_out', 'cancelled', 'reconciled')
            )
          `,
        )
        .run(retainAttemptsSince).changes || 0;

    result.deletedAttempts =
      db
        .prepare(
          `
            DELETE FROM ${attemptsTable}
            WHERE COALESCE(finished_at, last_progress_at, first_progress_at, stream_started_at, connect_started_at, leased_at, queue_entered_at) < ?
              AND state IN ('completed', 'failed', 'timed_out', 'cancelled', 'reconciled')
          `,
        )
        .run(retainAttemptsSince).changes || 0;

    result.deletedRequests =
      db
        .prepare(
          `
            DELETE FROM ${requestsTable}
            WHERE status IN ('completed', 'failed', 'timed_out', 'cancelled')
              AND COALESCE(completed_at, queued_at) < ?
              AND NOT EXISTS (
                SELECT 1
                FROM ${attemptsTable}
                WHERE ${attemptsTable}.request_id = ${requestsTable}.id
              )
          `,
        )
        .run(retainAttemptsSince).changes || 0;

    return result;
  }

  return {
    insertRequest,
    getRequest,
    updateRequestStatus,
    listQueuedRequests,
    insertAttempt,
    getAttempt,
    getLatestAttemptForRequest,
    listActiveAttempts,
    listAttemptsByState,
    leaseAttempt,
    transitionAttempt,
    insertAttemptEvent,
    listAttemptEvents,
    clearTables,
    pruneLedger,
  };
}
