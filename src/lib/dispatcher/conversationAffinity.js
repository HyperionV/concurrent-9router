import {
  getDispatchConversationAffinity,
  upsertDispatchConversationAffinity,
} from "@/lib/sqlite/dispatcherStore.js";
import { getApiKeyScope } from "@/lib/dispatcher/admissionPolicy.js";

import { deriveStablePrefixCacheKey } from "open-sse/utils/cacheKeyDerivation.js";

export function resolveConversationKey({
  body = {},
  clientRawRequest = null,
  metadata = {},
} = {}) {
  // Tier 1: Exact Turn Continuation
  const explicitTurn = body.previous_response_id || body.previousResponseId;
  if (typeof explicitTurn === "string" && explicitTurn.trim()) {
    return explicitTurn.trim();
  }

  // Tier 2: Explicit Client Session
  const candidates = [
    body.conversation_id,
    body.conversationId,
    body.session_id,
    body.metadata?.conversation_id,
    body.metadata?.conversationId,
    metadata?.conversationKey,
    clientRawRequest?.headers?.["x-conversation-id"],
    clientRawRequest?.headers?.["x-grok-conv-id"],
    clientRawRequest?.headers?.["session_id"],
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }

  // Tier 3: Content-addressable stable prefix hash
  return deriveStablePrefixCacheKey(body);
}

export function isCachePrefixKey(key) {
  return typeof key === "string" && (key.startsWith("pck_") || key.startsWith("pfx_"));
}

export function getConversationAffinity(
  conversationKey,
  apiKeyId = null,
  provider = null,
) {
  if (!conversationKey) return null;
  return getDispatchConversationAffinity(
    conversationKey,
    getApiKeyScope(apiKeyId),
    provider,
  );
}

export function persistConversationAffinity({
  conversationKey,
  provider,
  modelId,
  connectionId,
  sessionId,
  apiKeyId = null,
  state = "active",
}) {
  if (!conversationKey || !connectionId) return null;
  return upsertDispatchConversationAffinity({
    conversationKey,
    apiKeyScope: getApiKeyScope(apiKeyId),
    provider,
    modelId,
    connectionId,
    sessionId,
    apiKeyId,
    state,
  });
}
