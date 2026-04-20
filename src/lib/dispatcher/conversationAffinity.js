import {
  getDispatchConversationAffinity,
  upsertDispatchConversationAffinity,
} from "@/lib/sqlite/dispatcherStore.js";

export function resolveConversationKey({
  body = {},
  clientRawRequest = null,
  metadata = {},
} = {}) {
  const candidates = [
    body.previous_response_id,
    body.previousResponseId,
    body.conversation_id,
    body.conversationId,
    body.metadata?.conversation_id,
    body.metadata?.conversationId,
    metadata?.conversationKey,
    clientRawRequest?.headers?.["x-conversation-id"],
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }

  return null;
}

export function getConversationAffinity(conversationKey) {
  if (!conversationKey) return null;
  return getDispatchConversationAffinity(conversationKey);
}

export function persistConversationAffinity({
  conversationKey,
  provider,
  modelId,
  connectionId,
  sessionId,
  state = "active",
}) {
  if (!conversationKey || !connectionId) return null;
  return upsertDispatchConversationAffinity({
    conversationKey,
    provider,
    modelId,
    connectionId,
    sessionId,
    state,
  });
}
