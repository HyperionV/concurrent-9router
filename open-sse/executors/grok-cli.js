import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { BaseExecutor } from "./base.js";

const executionContext = new AsyncLocalStorage();
import {
  PROVIDERS,
  GROK_CLI_CLIENT_VERSION,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_TOKEN_AUTH,
} from "../config/providers.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { normalizeResponsesInput } from "../translator/helpers/responsesApiHelper.js";
import { deriveSessionId } from "../utils/sessionManager.js";
import { getConsistentMachineId } from "../../src/shared/utils/machineId.js";
import { getModelUpstreamId } from "../config/providerModels.js";

function resolveSessionId({ body, connectionId, workspaceId, scope }) {
  const fromBody =
    (typeof body?.prompt_cache_key === "string" && body.prompt_cache_key.trim()) ||
    (typeof body?.session_id === "string" && body.session_id.trim()) ||
    (typeof body?.conversation_id === "string" && body.conversation_id.trim()) ||
    null;
  if (fromBody) return fromBody;
  if (workspaceId) return String(workspaceId);
  return deriveSessionId(
    connectionId ? `${scope || "grok-cli"}:${connectionId}` : scope || "grok-cli",
  );
}

// Server-generated item id prefixes that /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

// Hosted tool types executed server-side by Grok CLI backend
const HOSTED_TOOL_TYPES = new Set([
  "web_search",
  "x_search",
  "web_search_preview",
  "file_search",
  "image_generation",
  "code_interpreter",
  "mcp",
  "local_shell",
]);

// Fields accepted by cli-chat-proxy Responses API (mirrors Codex allowlist + Grok extras)
const RESPONSES_API_ALLOWLIST = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "store",
  "reasoning",
  "include",
  "temperature",
  "top_p",
  "max_output_tokens",
  "parallel_tool_calls",
  "text",
  "metadata",
  "prompt_cache_key",
]);

const EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

export const GROK_CLI_NATIVE_ITEM_ID =
  /^(?:rs|msg|fc)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isNativeGrokCliItemId(id) {
  return typeof id === "string" && GROK_CLI_NATIVE_ITEM_ID.test(id);
}

export function supportsGrokCliReasoningEffort(model) {
  const m = String(model || "").toLowerCase();
  return /^grok-(?:4\.[56]|3)(?:$|-)/.test(m);
}

export function normalizeGrokCliEffort(value) {
  const effort = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (effort === "max") return "xhigh";
  if (effort === "ultra") return "high";
  if (effort === "minimal") return "low";
  if (effort === "none") return "none";
  if (["low", "medium", "high", "xhigh"].includes(effort)) return effort;
  return null;
}

const GROK_CLI_TURN_STORE_MAX = 5000;

// Per-session last turn index so multi-turn headers never go backwards within this process
const sessionTurnStore = new Map();

/**
 * Count user turns in a Responses `input` array.
 * Official CLI sets x-grok-turn-idx to the 1-based conversation turn (≈ user messages).
 * HAR: first chat turn → "1".
 */
export function countGrokCliUserTurns(input) {
  if (!Array.isArray(input)) return 1;
  let n = 0;
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const type = typeof item.type === "string" ? item.type : "";
    // Responses message items (type omitted or "message") with role user
    if (item.role === "user" && (!type || type === "message")) n += 1;
  }
  return Math.max(1, n);
}

/**
 * Resolve monotonic turn index for a session.
 * Prefers user-message count from the payload (full history clients), but never
 * decreases vs the last index observed for the same sessionId in this process.
 */
export function resolveGrokCliTurnIdx(sessionId, input) {
  const fromInput = countGrokCliUserTurns(input);
  if (!sessionId) return fromInput;
  const prev = sessionTurnStore.get(sessionId) || 0;
  const turn = Math.max(fromInput, prev);
  while (sessionTurnStore.size >= GROK_CLI_TURN_STORE_MAX) {
    sessionTurnStore.delete(sessionTurnStore.keys().next().value);
  }
  sessionTurnStore.set(sessionId, turn);
  return turn;
}

/** Test helper — clear in-memory turn counters */
export function _resetGrokCliTurnStore() {
  sessionTurnStore.clear();
}

const GROK_CLI_AGENT_STORE_MAX = 5000;
const sessionAgentStore = new Map();

/**
 * Resolve device / agent ID for x-grok-agent-id header.
 * - If connection explicitly pinned a fixed deviceId and didn't request rotation: use it
 * - If rotateDeviceId is true or no fixed deviceId is provided: rotate with random UUID
 * - When sessionId is present and rotateDeviceId !== "per-request", retain stable agentId across turns of the same session
 */
export function resolveGrokCliAgentId(sessionId, psd = {}) {
  if (psd.deviceId && psd.rotateDeviceId !== true) {
    return psd.deviceId;
  }
  if (psd.agentId && psd.rotateDeviceId !== true) {
    return psd.agentId;
  }

  if (sessionId && psd.rotateDeviceId !== "per-request") {
    const existing = sessionAgentStore.get(sessionId);
    if (existing) return existing;
    const generated = crypto.randomUUID();
    while (sessionAgentStore.size >= GROK_CLI_AGENT_STORE_MAX) {
      sessionAgentStore.delete(sessionAgentStore.keys().next().value);
    }
    sessionAgentStore.set(sessionId, generated);
    return generated;
  }

  return crypto.randomUUID();
}

/** Test helper — clear in-memory agent id counters */
export function _resetGrokCliAgentStore() {
  sessionAgentStore.clear();
}

function stringifyGrokCliToolOutput(output) {
  if (typeof output === "string") return output;
  if (output === undefined) return "";
  return JSON.stringify(output);
}

function normalizeGrokCliInputItem(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const { internal_chat_message_metadata_passthrough: _metadata, ...clean } = item;

  if (item.type === "reasoning") {
    if (!isNativeGrokCliItemId(item.id) || typeof item.encrypted_content !== "string") return null;
    return clean;
  }

  if (item.type === "custom_tool_call") {
    const callId = item.call_id || item.id;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!callId || !name) return null;
    return {
      type: "function_call",
      call_id: callId,
      name,
      arguments: JSON.stringify({ input: stringifyGrokCliToolOutput(item.input ?? item.arguments) }),
    };
  }

  if (item.type === "custom_tool_call_output" || item.type === "function_call_output") {
    const callId = item.call_id || item.id;
    if (!callId) return null;
    return {
      type: "function_call_output",
      call_id: callId,
      output: stringifyGrokCliToolOutput(item.output),
    };
  }

  if (item.type === "function_call") {
    const callId = item.call_id || item.id;
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!callId || !name) return null;
    return {
      type: "function_call",
      ...(isNativeGrokCliItemId(item.id) ? { id: item.id } : {}),
      call_id: callId,
      name,
      arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      ...(typeof item.status === "string" ? { status: item.status } : {}),
    };
  }

  return clean;
}

export function normalizeGrokCliInput(body) {
  if (!Array.isArray(body?.input)) return body;
  const normalized = body.input.map(normalizeGrokCliInputItem).filter(Boolean);
  const callIds = new Set(
    normalized
      .filter((item) => item?.type === "function_call" && item.call_id)
      .map((item) => item.call_id)
  );
  body.input = normalized.filter(
    (item) => item?.type !== "function_call_output" || callIds.has(item.call_id)
  );
  return body;
}

function stripStoredItemReferences(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.type === "item_reference") return false;
      // Preserve native Grok reasoning items with encrypted content; discard foreign ciphertext
      if (item.type === "reasoning") {
        if (
          !isNativeGrokCliItemId(item.id) ||
          typeof item.encrypted_content !== "string"
        ) {
          return false;
        }
        return true;
      }
      if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id)) {
        if (!isNativeGrokCliItemId(item.id)) {
          delete item.id;
        }
      }
    }
    return true;
  });
}

/**
 * Flatten Chat Completions tool shape → Responses flat format.
 * Keep hosted tools (web_search / x_search) passthrough.
 */
function normalizeGrokCliTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";

    if (type !== "function") {
      // Hosted tools: { type: "web_search" } / { type: "x_search" }
      if (HOSTED_TOOL_TYPES.has(type)) return true;
      // Nested function shape without type
      if (!type && tool.function) {
        // fall through to function flatten below
      } else if (!type || typeof tool.name === "string") {
        // treat as bare function if name present
      } else {
        return false;
      }
    }

    const isFunction =
      type === "function" || type === "" || tool.function || typeof tool.name === "string";
    if (!isFunction || HOSTED_TOOL_TYPES.has(type)) {
      return HOSTED_TOOL_TYPES.has(type);
    }

    const fn =
      tool.function && typeof tool.function === "object" && !Array.isArray(tool.function)
        ? tool.function
        : null;
    const rawName =
      typeof tool.name === "string" ? tool.name : typeof fn?.name === "string" ? fn.name : "";
    const name = rawName.trim();
    if (!name) return false;

    const description =
      typeof tool.description === "string"
        ? tool.description
        : typeof fn?.description === "string"
          ? fn.description
          : "";
    const parameters =
      tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters)
        ? tool.parameters
        : fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters)
          ? fn.parameters
          : { type: "object", properties: {} };

    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, 128);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(name);
    return true;
  });

  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

function resolveEffortFromModel(modelId) {
  if (!modelId || typeof modelId !== "string") return null;
  for (const level of EFFORT_LEVELS) {
    if (modelId.endsWith(`-${level}`)) return level;
  }
  return null;
}

/**
 * Grok CLI Executor — OpenAI Responses API on cli-chat-proxy.grok.com
 * Auth: OAuth device-code access token (xai-grok-cli).
 */
export class GrokCliExecutor extends BaseExecutor {
  constructor() {
    super("grok-cli", PROVIDERS["grok-cli"]);
    this._currentSessionId = null;
    this._currentReqId = null;
    this._currentTurnIdx = 1;
    this._agentId = null;
  }

  buildUrl() {
    return this.config.baseUrl;
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("grok-cli", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("grok-cli", credentials);
  }

  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);

    // Static fingerprint from registry
    const staticHeaders = this.config.headers || {};
    for (const [k, v] of Object.entries(staticHeaders)) {
      if (v != null && headers[k] === undefined) headers[k] = v;
    }

    // CLI chat-proxy identity (official CLI: xai-grok-workspace/<version>)
    const clientVersion =
      this.config.clientVersion || headers["x-grok-client-version"] || GROK_CLI_CLIENT_VERSION;
    headers["User-Agent"] = `xai-grok-workspace/${clientVersion}`;
    headers["x-xai-token-auth"] = this.config.tokenAuth || GROK_CLI_TOKEN_AUTH;
    headers["x-grok-client-identifier"] =
      this.config.clientIdentifier ||
      headers["x-grok-client-identifier"] ||
      GROK_CLI_CLIENT_IDENTIFIER;
    headers["x-grok-client-version"] = clientVersion;
    headers["x-authenticateresponse"] = "authenticate-response";

    const ctx = executionContext.getStore() || {};
    const sessionId =
      ctx.sessionId ||
      this._currentSessionId ||
      credentials?.connectionId ||
      crypto.randomUUID();
    const reqId = ctx.reqId || this._currentReqId || crypto.randomUUID();
    headers["x-grok-session-id"] = sessionId;
    // CLI uses the same id for conv + session on chat turns
    headers["x-grok-conv-id"] = sessionId;
    headers["x-grok-req-id"] = reqId;
    headers["x-grok-turn-idx"] = String(ctx.turnIdx || this._currentTurnIdx || 1);

    const psd = credentials?.providerSpecificData || {};
    const agentId =
      ctx.agentId ||
      this._agentId ||
      resolveGrokCliAgentId(sessionId, psd);
    if (agentId) headers["x-grok-agent-id"] = agentId;

    // Surface model override (CLI always sets this)
    const currentModel = ctx.model || this._currentModel;
    if (currentModel) headers["x-grok-model-override"] = currentModel;

    if (this.config.compactionAt) {
      headers["x-compaction-at"] = String(this.config.compactionAt);
    }

    // Identity: mapTokens stores email top-level AND in providerSpecificData;
    // fall back either way so OAuth connections always fingerprint like the CLI.
    const email = psd.email || credentials?.email;
    const userId = psd.userId || credentials?.userId || credentials?.providerUserId;
    if (email) headers["x-email"] = email;
    if (userId) headers["x-userid"] = userId;

    return headers;
  }

  parseError(response, bodyText) {
    // 402 personal-team-blocked:spending-limit → surface as payment/quota for fallback
    if (response.status === 402 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const code = json?.code || "";
        const msg = json?.error || json?.message || bodyText;
        return {
          status: 402,
          message: typeof msg === "string" ? msg : bodyText,
          code: typeof code === "string" ? code : undefined,
        };
      } catch {
        /* fall through */
      }
    }
    return super.parseError(response, bodyText);
  }

  transformRequest(model, body, stream, credentials) {
    const ctx = executionContext.getStore();
    // Session / request ids for headers — stable per client conversation when possible
    const sessionId = resolveSessionId({
      headers: credentials?.rawHeaders,
      body,
      connectionId: credentials?.connectionId || credentials?.id,
      workspaceId: credentials?.providerSpecificData?.workspaceId,
      scope: "grok-cli",
    });
    const reqId = crypto.randomUUID();
    const psd = credentials?.providerSpecificData || {};
    const agentId = ctx?.agentId || resolveGrokCliAgentId(sessionId, psd);

    this._currentSessionId = sessionId;
    this._currentReqId = reqId;
    this._agentId = agentId;
    if (ctx) {
      ctx.sessionId = sessionId;
      ctx.reqId = reqId;
      if (agentId) ctx.agentId = agentId;
    }

    // Normalize Responses input
    const normalized = normalizeResponsesInput(body.input);
    if (normalized) body.input = normalized;
    normalizeGrokCliInput(body);

    // Chat Completions clients arrive with messages[] — translator should have
    // converted already, but guard empty input.
    if (!body.input || (Array.isArray(body.input) && body.input.length === 0)) {
      if (Array.isArray(body.messages) && body.messages.length > 0) {
        // Soft fallback: map messages → input messages (string content only)
        body.input = body.messages.map((m) => ({
          type: "message",
          role: m.role || "user",
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        }));
        delete body.messages;
      } else {
        body.input = [{ type: "message", role: "user", content: "..." }];
      }
    }

    // Keep role:"system" as-is — official grok-pager HAR sends system, not developer
    // (Codex converts system→developer; Grok CLI does not).
    stripStoredItemReferences(body);
    normalizeGrokCliTools(body);

    // Turn index after input is finalized (user-message count, monotonic per session)
    const turnIdx = resolveGrokCliTurnIdx(sessionId, body.input);
    this._currentTurnIdx = turnIdx;
    if (ctx) {
      ctx.turnIdx = turnIdx;
    }

    body.stream = true;
    body.store = false;

    // Resolve upstream model id (strip effort suffix virtual models)
    let modelEffort = resolveEffortFromModel(body.model || model);
    let resolvedModel = body.model || model;
    if (modelEffort) {
      resolvedModel = resolvedModel.replace(new RegExp(`-${modelEffort}$`), "");
    }
    resolvedModel = getModelUpstreamId("gcli", resolvedModel) || resolvedModel;
    // Also try provider id key
    if (resolvedModel === (body.model || model)) {
      resolvedModel = getModelUpstreamId("grok-cli", resolvedModel) || resolvedModel;
    }
    body.model = resolvedModel;
    this._currentModel = resolvedModel;
    if (ctx) {
      ctx.model = resolvedModel;
    }

    // Reasoning effort priority: explicit reasoning.effort > reasoning_effort > model suffix
    const isEffortSupported = supportsGrokCliReasoningEffort(resolvedModel);
    const rawEffort =
      body.reasoning?.effort ||
      body.reasoning_effort ||
      modelEffort ||
      null;
    const normalizedEffort = normalizeGrokCliEffort(rawEffort);

    if (isEffortSupported) {
      // Allow user to select any level (none, low, medium, high, xhigh)
      // If none specified anywhere, fallback to "low" for speed
      const effectiveEffort = normalizedEffort || "low";
      if (!body.reasoning || typeof body.reasoning !== "object") {
        body.reasoning = { effort: effectiveEffort, summary: "concise" };
      } else {
        body.reasoning.effort = effectiveEffort;
        if (!body.reasoning.summary) body.reasoning.summary = "concise";
      }
    } else {
      // Model does not accept reasoning effort parameter (e.g. grok-build)
      if (!body.reasoning || typeof body.reasoning !== "object") {
        body.reasoning = { summary: "concise" };
      } else {
        delete body.reasoning.effort;
        if (!body.reasoning.summary) body.reasoning.summary = "concise";
      }
    }
    delete body.reasoning_effort;

    // Encrypted reasoning for multi-turn continuity (CLI always requests this)
    if (body.reasoning?.effort ? body.reasoning.effort !== "none" : isEffortSupported) {
      const include = Array.isArray(body.include) ? body.include : [];
      if (!include.includes("reasoning.encrypted_content")) {
        include.push("reasoning.encrypted_content");
      }
      body.include = include;
    }

    // Drop Chat Completions leftovers that Responses rejects
    delete body.messages;
    delete body.max_tokens;
    delete body.max_completion_tokens;
    delete body.n;
    delete body.seed;
    delete body.logprobs;
    delete body.top_logprobs;
    delete body.frequency_penalty;
    delete body.presence_penalty;
    delete body.logit_bias;
    delete body.user;
    delete body.stream_options;
    delete body.prompt_cache_retention;
    delete body.safety_identifier;
    delete body.previous_response_id; // store=false → cannot resolve

    for (const k of Object.keys(body)) {
      if (!RESPONSES_API_ALLOWLIST.has(k)) delete body[k];
    }

    return body;
  }

  async execute(args) {
    const psd = args.credentials?.providerSpecificData || {};
    const bodySessionId =
      (typeof args.body?.prompt_cache_key === "string" && args.body.prompt_cache_key.trim()) ||
      (typeof args.body?.session_id === "string" && args.body.session_id.trim()) ||
      (typeof args.body?.conversation_id === "string" && args.body.conversation_id.trim()) ||
      null;
    const agentId = resolveGrokCliAgentId(bodySessionId, psd);

    const ctx = {
      agentId,
    };
    return executionContext.run(ctx, () => super.execute(args));
  }
}

export default GrokCliExecutor;
