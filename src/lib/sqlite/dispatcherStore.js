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

function normalizeAffinity(row) {
  if (!row) return null;
  return {
    conversationKey: row.conversation_key,
    provider: row.provider,
    modelId: row.model_id,
    connectionId: row.connection_id,
    sessionId: row.session_id,
    state: row.state,
    updatedAt: row.updated_at,
  };
}

export function insertDispatchRequest(record) {
  const db = getSqlite();
  const queuedAt = record.queuedAt || nowIso();
  db.prepare(
    `
      INSERT INTO dispatch_requests(
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
  return getDispatchRequest(record.id);
}

export function getDispatchRequest(id) {
  const row = getSqlite()
    .prepare("SELECT * FROM dispatch_requests WHERE id = ?")
    .get(id);
  return normalizeRequest(row);
}

export function updateDispatchRequestStatus(id, status, updates = {}) {
  const db = getSqlite();
  db.prepare(
    `
      UPDATE dispatch_requests
      SET status = @status,
          completed_at = COALESCE(@completedAt, completed_at),
          expires_at = COALESCE(@expiresAt, expires_at),
          metadata_json = @metadataJson
      WHERE id = @id
    `,
  ).run({
    id,
    status,
    completedAt: updates.completedAt || null,
    expiresAt: updates.expiresAt || null,
    metadataJson: stringifyJson(
      updates.metadata ?? getDispatchRequest(id)?.metadata ?? {},
    ),
  });
  return getDispatchRequest(id);
}

export function listQueuedDispatchRequests(provider, limit = 100) {
  const rows = getSqlite()
    .prepare(
      `
        SELECT *
        FROM dispatch_requests
        WHERE provider = ?
          AND status = 'queued'
        ORDER BY queued_at ASC
        LIMIT ?
      `,
    )
    .all(provider, limit);
  return rows.map(normalizeRequest);
}

export function insertDispatchAttempt(record) {
  const db = getSqlite();
  db.prepare(
    `
      INSERT INTO dispatch_attempts(
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
  ).run({
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
  return getDispatchAttempt(record.id);
}

export function getDispatchAttempt(id) {
  const row = getSqlite()
    .prepare("SELECT * FROM dispatch_attempts WHERE id = ?")
    .get(id);
  return normalizeAttempt(row);
}

export function getLatestDispatchAttemptForRequest(requestId) {
  const row = getSqlite()
    .prepare(
      `
        SELECT *
        FROM dispatch_attempts
        WHERE request_id = ?
        ORDER BY attempt_index DESC
        LIMIT 1
      `,
    )
    .get(requestId);
  return normalizeAttempt(row);
}

export function listActiveDispatchAttempts(provider = null) {
  const sql = provider
    ? `
        SELECT *
        FROM dispatch_attempts
        WHERE provider = ?
          AND state IN ('leased', 'connecting', 'streaming')
        ORDER BY queue_entered_at ASC
      `
    : `
        SELECT *
        FROM dispatch_attempts
        WHERE state IN ('leased', 'connecting', 'streaming')
        ORDER BY queue_entered_at ASC
      `;
  const rows = provider
    ? getSqlite().prepare(sql).all(provider)
    : getSqlite().prepare(sql).all();
  return rows.map(normalizeAttempt);
}

export function listDispatchAttemptsByState(states) {
  if (!Array.isArray(states) || states.length === 0) {
    return [];
  }
  const placeholders = states.map(() => "?").join(", ");
  const rows = getSqlite()
    .prepare(
      `
        SELECT *
        FROM dispatch_attempts
        WHERE state IN (${placeholders})
        ORDER BY queue_entered_at ASC
      `,
    )
    .all(...states);
  return rows.map(normalizeAttempt);
}

export function leaseDispatchAttempt(attemptId, lease) {
  const db = getSqlite();
  const result = db
    .prepare(
      `
      UPDATE dispatch_attempts
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
  return result.changes === 1 ? getDispatchAttempt(attemptId) : null;
}

export function transitionDispatchAttempt(
  attemptId,
  fromStates,
  nextState,
  updates = {},
) {
  const states = Array.isArray(fromStates) ? fromStates : [fromStates];
  const db = getSqlite();
  const placeholders = states.map(() => "?").join(", ");
  const errorJson = stringifyJson(updates.error || {});
  const result = db
    .prepare(
      `
      UPDATE dispatch_attempts
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
  return result.changes === 1 ? getDispatchAttempt(attemptId) : null;
}

export function insertDispatchAttemptEvent(event) {
  getSqlite()
    .prepare(
      `
        INSERT INTO dispatch_attempt_events(id, attempt_id, event_type, at, payload_json)
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

export function listDispatchAttemptEvents(attemptId) {
  const rows = getSqlite()
    .prepare(
      `
        SELECT *
        FROM dispatch_attempt_events
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

export function upsertDispatchConversationAffinity(record) {
  const updatedAt = record.updatedAt || nowIso();
  getSqlite()
    .prepare(
      `
        INSERT INTO dispatch_conversation_affinity(
          conversation_key, provider, model_id, connection_id, session_id, state, updated_at
        ) VALUES (
          @conversationKey, @provider, @modelId, @connectionId, @sessionId, @state, @updatedAt
        )
        ON CONFLICT(conversation_key) DO UPDATE SET
          provider = excluded.provider,
          model_id = excluded.model_id,
          connection_id = excluded.connection_id,
          session_id = excluded.session_id,
          state = excluded.state,
          updated_at = excluded.updated_at
      `,
    )
    .run({
      conversationKey: record.conversationKey,
      provider: record.provider,
      modelId: record.modelId || null,
      connectionId: record.connectionId,
      sessionId: record.sessionId || null,
      state: record.state || "active",
      updatedAt,
    });
  return getDispatchConversationAffinity(record.conversationKey);
}

export function getDispatchConversationAffinity(conversationKey) {
  const row = getSqlite()
    .prepare(
      `
        SELECT *
        FROM dispatch_conversation_affinity
        WHERE conversation_key = ?
      `,
    )
    .get(conversationKey);
  return normalizeAffinity(row);
}

export function clearDispatchTables() {
  const db = getSqlite();
  db.prepare("DELETE FROM dispatch_attempt_events").run();
  db.prepare("DELETE FROM dispatch_attempts").run();
  db.prepare("DELETE FROM dispatch_requests").run();
  db.prepare("DELETE FROM dispatch_conversation_affinity").run();
}
