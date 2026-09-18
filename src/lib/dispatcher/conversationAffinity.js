import {
  getDispatchConversationAffinity,
  upsertDispatchConversationAffinity,
} from "@/lib/sqlite/dispatcherStore.js";
import { getApiKeyScope } from "@/lib/dispatcher/admissionPolicy.js";

function extractPrefixAnchor(body) {
  if (!body || typeof body !== "object") return null;

  if (typeof body.prompt_cache_key === "string" && body.prompt_cache_key.trim()) {
    return body.prompt_cache_key.trim();
  }
  if (typeof body.session_id === "string" && body.session_id.trim()) {
    return body.session_id.trim();
  }

  // Multi-turn chat (messages format)
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const firstMsg = body.messages[0];
    const text =
      typeof firstMsg?.content === "string"
        ? firstMsg.content
        : Array.isArray(firstMsg?.content)
          ? firstMsg.content.find((c) => c?.type === "text" || c?.text)?.text || ""
          : "";
    if (typeof text === "string" && text.trim().length >= 8) {
      return text.trim().slice(0, 512);
    }
  }

  // Responses format (instructions or input items)
  if (typeof body.instructions === "string" && body.instructions.trim().length >= 8) {
    return body.instructions.trim().slice(0, 512);
  }
  if (Array.isArray(body.input) && body.input.length > 0) {
    const firstItem = body.input[0];
    const text =
      typeof firstItem?.content === "string"
        ? firstItem.content
        : Array.isArray(firstItem?.content)
          ? firstItem.content.find((c) => c?.type === "input_text" || c?.text)?.text || ""
          : "";
    if (typeof text === "string" && text.trim().length >= 8) {
      return text.trim().slice(0, 512);
    }
  }

  return null;
}

function fnv1aHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `pfx_${(hash >>> 0).toString(16)}`;
}

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
    clientRawRequest?.headers?.["session_id"],
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }

  // Fallback: content-addressable prefix hash for prompt cache affinity
  const anchor = extractPrefixAnchor(body);
  if (anchor) {
    return fnv1aHash(anchor);
  }

  return null;
}

export function isCachePrefixKey(key) {
  return typeof key === "string" && key.startsWith("pfx_");
}

export function getConversationAffinity(conversationKey, apiKeyId = null) {
  if (!conversationKey) return null;
  return getDispatchConversationAffinity(
    conversationKey,
    getApiKeyScope(apiKeyId),
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
