import { getSqlite } from "@/lib/sqlite/runtime.js";
import { nowIso } from "@/lib/sqlite/helpers.js";
import { createDispatchLedgerStore } from "@/lib/sqlite/dispatchLedgerStoreFactory.js";

const textLedger = createDispatchLedgerStore({
  requestsTable: "dispatch_requests",
  attemptsTable: "dispatch_attempts",
  eventsTable: "dispatch_attempt_events",
  leaseEntersConnecting: true,
});

export const insertDispatchRequest = textLedger.insertRequest;
export const getDispatchRequest = textLedger.getRequest;
export const updateDispatchRequestStatus = textLedger.updateRequestStatus;
export const listQueuedDispatchRequests = textLedger.listQueuedRequests;
export const insertDispatchAttempt = textLedger.insertAttempt;
export const getDispatchAttempt = textLedger.getAttempt;
export const getLatestDispatchAttemptForRequest = textLedger.getLatestAttemptForRequest;
export const listActiveDispatchAttempts = textLedger.listActiveAttempts;
export const listDispatchAttemptsByState = textLedger.listAttemptsByState;
export const leaseDispatchAttempt = textLedger.leaseAttempt;
export const transitionDispatchAttempt = textLedger.transitionAttempt;
export const insertDispatchAttemptEvent = textLedger.insertAttemptEvent;
export const listDispatchAttemptEvents = textLedger.listAttemptEvents;

function normalizeAffinity(row) {
  if (!row) return null;
  return {
    conversationKey: row.conversation_key,
    apiKeyScope: row.api_key_scope,
    provider: row.provider,
    modelId: row.model_id,
    connectionId: row.connection_id,
    sessionId: row.session_id,
    apiKeyId: row.api_key_id || null,
    state: row.state,
    updatedAt: row.updated_at,
  };
}

export function upsertDispatchConversationAffinity(record) {
  const updatedAt = record.updatedAt || nowIso();
  getSqlite()
    .prepare(
      `
        INSERT INTO dispatch_conversation_affinity(
          conversation_key, api_key_scope, provider, model_id, connection_id, session_id, api_key_id, state, updated_at
        ) VALUES (
          @conversationKey, @apiKeyScope, @provider, @modelId, @connectionId, @sessionId, @apiKeyId, @state, @updatedAt
        )
        ON CONFLICT(conversation_key, api_key_scope, provider) DO UPDATE SET
          model_id = excluded.model_id,
          connection_id = excluded.connection_id,
          session_id = excluded.session_id,
          api_key_id = excluded.api_key_id,
          state = excluded.state,
          updated_at = excluded.updated_at
      `,
    )
    .run({
      conversationKey: record.conversationKey,
      apiKeyScope: record.apiKeyScope,
      provider: record.provider,
      modelId: record.modelId || null,
      connectionId: record.connectionId,
      sessionId: record.sessionId || null,
      apiKeyId: record.apiKeyId || null,
      state: record.state || "active",
      updatedAt,
    });
  return getDispatchConversationAffinity(
    record.conversationKey,
    record.apiKeyScope,
    record.provider,
  );
}

export function getDispatchConversationAffinity(
  conversationKey,
  apiKeyScope = "__no_key__",
  provider = null,
) {
  if (provider) {
    const row = getSqlite()
      .prepare(
        `
          SELECT *
          FROM dispatch_conversation_affinity
          WHERE conversation_key = ?
            AND api_key_scope = ?
            AND provider = ?
        `,
      )
      .get(conversationKey, apiKeyScope, provider);
    if (row) return normalizeAffinity(row);
  }
  const row = getSqlite()
    .prepare(
      `
        SELECT *
        FROM dispatch_conversation_affinity
        WHERE conversation_key = ?
          AND api_key_scope = ?
      `,
    )
    .get(conversationKey, apiKeyScope);
  return normalizeAffinity(row);
}

export function clearDispatchTables() {
  textLedger.clearTables();
  getSqlite().prepare("DELETE FROM dispatch_conversation_affinity").run();
}

export function pruneDispatchLedger({
  retainAttemptsSince = null,
  retainAffinitySince = null,
} = {}) {
  const result = {
    ...textLedger.pruneLedger({ retainAttemptsSince }),
    deletedAffinity: 0,
  };
  if (retainAffinitySince) {
    result.deletedAffinity =
      getSqlite()
        .prepare("DELETE FROM dispatch_conversation_affinity WHERE updated_at < ?")
        .run(retainAffinitySince).changes || 0;
  }
  return result;
}
