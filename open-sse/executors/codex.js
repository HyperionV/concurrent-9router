import { createHash } from "crypto";
import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { PROVIDERS } from "../config/providers.js";
import { normalizeResponsesInput } from "../translator/helpers/responsesApiHelper.js";
import { fetchImageAsBase64 } from "../translator/helpers/imageHelper.js";
import {
  DEFAULT_RETRY_CONFIG,
  HTTP_STATUS,
  resolveRetryEntry,
} from "../config/runtimeConfig.js";
import { getConsistentMachineId } from "../../src/shared/utils/machineId.js";
import {
  refreshProviderCredentials,
  shouldRefreshCredentials,
} from "../services/oauthCredentialManager.js";
import { getModelUpstreamId } from "../config/providerModels.js";
import { stripCodexUnsupportedPatterns } from "../utils/codexToolSchema.js";
import { deriveStablePrefixCacheKey } from "../utils/cacheKeyDerivation.js";
import {
  dropUnresolvableToolChoice,
  hasServerItemId,
  isStoredItemReference,
  readFunctionTool,
  splitEffortSuffix,
} from "./responsesRequestShaping.js";

// SSE error patterns inside 200-OK bodies. Some retry same account first; capacity rotates accounts.
const CODEX_SSE_RETRY_PATTERNS = [
  "server_is_overloaded",
  "service_unavailable_error",
];
const CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS = [
  "selected model is at capacity",
  "model_at_capacity",
];
// Once one of these reaches the client the request can no longer be retried, so the peek stops.
const CODEX_SSE_OUTPUT_EVENT_TYPES = new Set([
  "response.output_text.delta",
  "response.function_call_arguments.delta",
  "response.reasoning_summary_text.delta",
  "response.reasoning_text.delta",
  "response.reasoning.delta",
  "response.output_item.added",
  "response.content_part.added",
]);
const CODEX_SSE_TERMINAL_EVENT_TYPES = new Set([
  "response.completed",
  "response.incomplete",
  "response.done",
]);
const CODEX_SSE_ERROR_EVENT_TYPES = new Set(["error", "response.failed"]);
// response.created and response.in_progress each echo the full instructions and tools (13 KB+
// apiece in production), so an overload error that arrives before any output can sit tens of KB
// into the stream. The peek reads whole events until output starts; this cap only bounds memory.
const CODEX_SSE_PEEK_MAX_BYTES = 512 * 1024;
const SSE_EVENT_SEPARATOR = /\r?\n\r?\n/;
const CODEX_MODEL_CAPACITY_MESSAGE =
  "Selected model is at capacity. Please try a different model.";
const SESSION_TTL_MS = 60 * 60 * 1000;
const CODEX_HOSTED_TOOL_TYPES = new Set([
  "image_generation",
  "web_search",
  "web_search_preview",
  "file_search",
  "computer",
  "computer_use_preview",
  "code_interpreter",
  "mcp",
  "local_shell",
  "tool_search",
]);
const CODEX_PASSTHROUGH_TOOL_TYPES = new Set(["custom"]);
const assistantSessionMap = new Map();
let cachedMachineId = null;
getConsistentMachineId()
  .then((id) => {
    cachedMachineId = id;
  })
  .catch(() => {});

function hashContent(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function generateSessionId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) return null;
  return normalized;
}

function extractItemText(item) {
  if (!item) return "";
  if (typeof item.content === "string") return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .map((content) => content?.text || content?.output || "")
      .filter(Boolean)
      .join("");
  }
  return "";
}

function resolveCacheSessionId(body, credentials, explicitSessionId = null) {
  const fromBody =
    normalizeSessionId(body?.prompt_cache_key) ||
    normalizeSessionId(body?.session_id) ||
    normalizeSessionId(body?.conversation_id);
  if (fromBody) return fromBody;

  const fromDispatcher = normalizeSessionId(
    explicitSessionId || credentials?.providerSpecificData?.dispatchSessionId,
  );
  if (fromDispatcher) return fromDispatcher;

  const stablePrefix = deriveStablePrefixCacheKey(body);
  if (stablePrefix) return stablePrefix;

  if (Array.isArray(body?.input)) {
    let assistantText = "";
    for (const item of body.input) {
      if (item?.role !== "assistant") continue;
      assistantText += extractItemText(item);
      if (assistantText.length >= 200) break;
    }
    if (assistantText.length >= 50) {
      const hash = hashContent(
        `${cachedMachineId || ""}:${assistantText.slice(0, 200)}`,
      );
      const existing = assistantSessionMap.get(hash);
      if (existing) {
        existing.lastUsed = Date.now();
        return existing.sessionId;
      }
      const sessionId = generateSessionId();
      assistantSessionMap.set(hash, { sessionId, lastUsed: Date.now() });
      return sessionId;
    }
  }

  const workspaceId =
    normalizeSessionId(credentials?.providerSpecificData?.workspaceId) ||
    normalizeSessionId(credentials?.providerSpecificData?.chatgptAccountId) ||
    normalizeSessionId(credentials?.providerSpecificData?.accountId);
  if (workspaceId) return workspaceId;

  return cachedMachineId
    ? `sess_${hashContent(cachedMachineId)}`
    : generateSessionId();
}

function convertSystemToDeveloperRole(body) {
  if (!Array.isArray(body.input)) return;
  for (const item of body.input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    if (item.role === "system" && (!item.type || item.type === "message")) {
      item.role = "developer";
    }
  }
}

const CODEX_GPT_5_6_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

function getCodexThinkingLevels(model) {
  const m = String(model || "").toLowerCase();
  if (m.includes("gpt-5.6-sol") || m.includes("gpt-5.6-terra")) {
    return [...CODEX_GPT_5_6_LEVELS, "ultra"];
  }
  if (m.includes("gpt-5.6-luna")) {
    return CODEX_GPT_5_6_LEVELS;
  }
  return ["none", "minimal", "low", "medium", "high", "xhigh"];
}

function normalizeReasoningEffort(model, value) {
  const supportedLevels = getCodexThinkingLevels(model);
  if (supportedLevels?.includes(value)) return value;
  if (value === "ultra" && supportedLevels?.includes("max")) return "max";
  if (value === "max" || value === "ultra") return "xhigh";
  return value;
}

function findNestedMessage(value, depth = 0) {
  if (!value || depth > 6 || typeof value === "string") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  if (typeof value.message === "string" && value.message.trim())
    return value.message;
  if (
    typeof value.error?.message === "string" &&
    value.error.message.trim()
  ) {
    return value.error.message;
  }
  if (
    typeof value.response?.error?.message === "string" &&
    value.response.error.message.trim()
  ) {
    return value.response.error.message;
  }
  for (const child of Object.values(value)) {
    const found = findNestedMessage(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function extractSseErrorMessage(text, fallback) {
  const exact = text?.match(
    /Selected model is at capacity\. Please try a different model\./i,
  )?.[0];
  if (exact) return exact;

  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const message = findNestedMessage(JSON.parse(data));
      if (message) return message;
    } catch {
      // Ignore non-JSON SSE data lines.
    }
  }

  return fallback || CODEX_MODEL_CAPACITY_MESSAGE;
}

/**
 * What one complete SSE event means for the peek: "capacity" or "retry" for an error event the
 * router can still recover from, "pass" when the stream must go to the client as it is (output
 * started, the response ended, or an error the router does not retry), "continue" otherwise.
 * Only error events are matched, so the instructions echoed in response.created cannot trigger it.
 */
function classifyPeekedSseEvent(rawEvent) {
  let eventName = null;
  const dataLines = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  const dataText = dataLines.join("\n");
  if (dataText === "[DONE]") return { kind: "pass", matched: null };

  let data = null;
  try {
    data = JSON.parse(dataText);
  } catch {
    // Non-JSON data lines carry no event type.
  }
  const eventType = eventName || data?.type || null;
  const isErrorEvent =
    CODEX_SSE_ERROR_EVENT_TYPES.has(eventType) ||
    (data?.error != null && typeof data.error === "object");

  if (isErrorEvent) {
    const lowerEvent = rawEvent.toLowerCase();
    const capacityHit = CODEX_SSE_ACCOUNT_FALLBACK_PATTERNS.find((p) =>
      lowerEvent.includes(p),
    );
    if (capacityHit) return { kind: "capacity", matched: capacityHit };
    const retryHit = CODEX_SSE_RETRY_PATTERNS.find((p) => lowerEvent.includes(p));
    if (retryHit) return { kind: "retry", matched: retryHit };
    return { kind: "pass", matched: null };
  }
  if (
    CODEX_SSE_OUTPUT_EVENT_TYPES.has(eventType) ||
    CODEX_SSE_TERMINAL_EVENT_TYPES.has(eventType)
  ) {
    return { kind: "pass", matched: null };
  }
  return { kind: "continue", matched: null };
}

function codexSseErrorResponse(status, message) {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: status >= 500 ? "server_error" : "invalid_request_error",
        code:
          status === HTTP_STATUS.SERVICE_UNAVAILABLE
            ? "service_unavailable"
            : "upstream_error",
      },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function stripStoredItemReferences(body) {
  delete body.previous_response_id;
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (isStoredItemReference(item)) return false;
    if (hasServerItemId(item)) delete item.id;
    return true;
  });
}

function normalizeCodexTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  const patternStats = { removed: 0 };
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const type = typeof tool.type === "string" ? tool.type : "";
    if (type === "namespace") {
      if (Array.isArray(tool.tools)) {
        for (const nested of tool.tools) {
          const name =
            typeof nested?.name === "string"
              ? nested.name.trim().slice(0, 128)
              : "";
          if (name) validNames.add(name);
          if (nested?.parameters && typeof nested.parameters === "object") {
            nested.parameters = stripCodexUnsupportedPatterns(
              nested.parameters,
              patternStats,
            );
          }
        }
      }
      return true;
    }
    if (type !== "function") {
      if (CODEX_PASSTHROUGH_TOOL_TYPES.has(type)) return true;
      if (!type || tool.function || typeof tool.name === "string") return false;
      return CODEX_HOSTED_TOOL_TYPES.has(type);
    }
    const { name: fullName, description, parameters } = readFunctionTool(tool);
    const name = fullName.slice(0, 128);
    if (!name) return false;
    for (const key of Object.keys(tool)) delete tool[key];
    tool.type = "function";
    tool.name = name;
    if (description) tool.description = description;
    tool.parameters = stripCodexUnsupportedPatterns(parameters, patternStats);
    validNames.add(name);
    return true;
  });

  dropUnresolvableToolChoice(body, validNames);
}

setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of assistantSessionMap) {
      if (now - entry.lastUsed > SESSION_TTL_MS)
        assistantSessionMap.delete(key);
    }
  },
  10 * 60 * 1000,
).unref?.();

/**
 * Codex Executor - handles OpenAI Codex API (Responses API format)
 * Automatically injects default instructions if missing
 */
export class CodexExecutor extends BaseExecutor {
  constructor() {
    super("codex", PROVIDERS.codex);
  }

  buildHeaders(credentials, stream = true) {
    const headers = super.buildHeaders(credentials, stream);
    const sessionId =
      credentials?.providerSpecificData?.dispatchSessionId ||
      credentials?.connectionId ||
      generateSessionId();
    headers.session_id = sessionId;
    headers.originator = "codex_cli_rs";
    const chatgptAccountId =
      credentials?.providerSpecificData?.workspaceId ||
      credentials?.providerSpecificData?.chatgptAccountId ||
      credentials?.providerSpecificData?.accountId;
    if (chatgptAccountId && !headers["chatgpt-account-id"]) {
      headers["chatgpt-account-id"] = chatgptAccountId;
    }
    return headers;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const baseUrl = super.buildUrl(model, stream, urlIndex, credentials);
    return credentials?.providerSpecificData?.dispatchCompact === true
      ? `${baseUrl}/compact`
      : baseUrl;
  }

  async refreshCredentials(credentials, log) {
    if (!credentials?.refreshToken) return null;
    return refreshProviderCredentials("codex", credentials, log);
  }

  needsRefresh(credentials) {
    return shouldRefreshCredentials("codex", credentials);
  }

  /**
   * Prefetch remote image URLs and inline them as base64 data URIs.
   * Runs before execute() because Codex backend cannot fetch remote images.
   * Mutates body.input in place.
   */
  async prefetchImages(body, proxyOptions = null) {
    if (!Array.isArray(body?.input)) return;
    for (const item of body.input) {
      if (!Array.isArray(item.content)) continue;
      const pending = item.content.map(async (c) => {
        if (c.type !== "image_url") return c;
        const url =
          typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        const detail = c.image_url?.detail || "auto";
        if (!url) return c;
        if (url.startsWith("data:"))
          return { type: "input_image", image_url: url, detail };
        const fetched = await fetchImageAsBase64(url, {
          timeoutMs: 15000,
          proxyOptions,
        });
        return { type: "input_image", image_url: fetched?.url || url, detail };
      });
      item.content = await Promise.all(pending);
    }
  }

  buildRequest({ model, body, stream = true, credentials, sessionId = null }) {
    const workingBody = structuredClone(body || {});
    const isCompact = !!workingBody._compact;
    delete workingBody._compact;

    // Convert string input to array format (Codex API requires input as array)
    const normalized = normalizeResponsesInput(workingBody.input);
    if (normalized) workingBody.input = normalized;

    // Ensure input is present and non-empty (Codex API rejects empty input)
    if (
      !workingBody.input ||
      (Array.isArray(workingBody.input) && workingBody.input.length === 0)
    ) {
      workingBody.input = [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "..." }],
        },
      ];
    }

    const resolvedSessionId = resolveCacheSessionId(
      workingBody,
      credentials,
      sessionId,
    );
    if (!credentials?.providerSpecificData?.dispatchSessionId) {
      convertSystemToDeveloperRole(workingBody);
    }
    stripStoredItemReferences(workingBody);
    normalizeCodexTools(workingBody);

    // Ensure streaming is enabled (Codex API requires it)
    workingBody.stream = true;

    // If no instructions provided, inject default Codex instructions
    if (!workingBody.instructions || workingBody.instructions.trim() === "") {
      workingBody.instructions = CODEX_DEFAULT_INSTRUCTIONS;
    }

    // Ensure store is false (Codex requirement)
    workingBody.store = false;

    // Map review / virtual models to upstream id first
    const requestModel =
      getModelUpstreamId("cx", model) ||
      getModelUpstreamId("codex", model) ||
      model;

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    // The suffix is stripped from the model name sent upstream.
    const { model: upstreamModel, effort: modelEffort } =
      splitEffortSuffix(requestModel);
    workingBody.model = upstreamModel;

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default
    if (!workingBody.reasoning) {
      const effort = normalizeReasoningEffort(
        workingBody.model,
        workingBody.reasoning_effort || modelEffort || "low",
      );
      workingBody.reasoning = { effort, summary: "auto" };
    } else {
      workingBody.reasoning.effort = normalizeReasoningEffort(
        workingBody.model,
        workingBody.reasoning.effort,
      );
      if (!workingBody.reasoning.summary) {
        workingBody.reasoning.summary = "auto";
      }
    }
    delete workingBody.reasoning_effort;

    // Include reasoning encrypted content (required by Codex backend for reasoning models)
    if (
      workingBody.reasoning &&
      workingBody.reasoning.effort &&
      workingBody.reasoning.effort !== "none"
    ) {
      workingBody.include = ["reasoning.encrypted_content"];
    }

    // Remove unsupported parameters for Codex API
    delete workingBody.temperature;
    delete workingBody.top_p;
    delete workingBody.frequency_penalty;
    delete workingBody.presence_penalty;
    delete workingBody.logprobs;
    delete workingBody.top_logprobs;
    delete workingBody.n;
    delete workingBody.seed;
    delete workingBody.max_tokens;
    delete workingBody.max_completion_tokens;
    delete workingBody.max_output_tokens;
    delete workingBody.user; // Cursor sends this but Codex doesn't support it
    delete workingBody.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete workingBody.metadata; // Cursor sends this but Codex doesn't support it
    delete workingBody.stream_options; // Cursor sends this but Codex doesn't support it
    delete workingBody.safety_identifier; // Droid CLI sends this but Codex doesn't support it
    delete workingBody.previous_response_id;
    delete workingBody.stop; // Chat Completions parameter unsupported on /responses
    delete workingBody.parallel_tool_calls; // Chat Completions parameter unsupported on /responses

    // Fast tier maps to Codex priority; unknown tiers are stripped
    if (workingBody.service_tier === "fast") {
      workingBody.service_tier = "priority";
    }
    if (
      workingBody.service_tier &&
      workingBody.service_tier !== "priority"
    ) {
      delete workingBody.service_tier;
    }

    if (!workingBody.prompt_cache_key && resolvedSessionId) {
      workingBody.prompt_cache_key = resolvedSessionId;
    }

    const url = isCompact
      ? `${super.buildUrl(model, stream, 0, credentials)}/compact`
      : super.buildUrl(model, stream, 0, credentials);
    const headers = super.buildHeaders(credentials, stream);
    headers.session_id = resolvedSessionId;

    headers.originator = "codex_cli_rs";
    const chatgptAccountId =
      credentials?.providerSpecificData?.workspaceId ||
      credentials?.providerSpecificData?.chatgptAccountId ||
      credentials?.providerSpecificData?.accountId;
    if (chatgptAccountId && !headers["chatgpt-account-id"]) {
      headers["chatgpt-account-id"] = chatgptAccountId;
    }

    return {
      url,
      headers,
      transformedBody: workingBody,
      sessionId: headers.session_id,
      isCompact,
    };
  }

  transformRequest(model, body, stream = true, credentials = null) {
    const { transformedBody } = this.buildRequest({
      model,
      body,
      stream,
      credentials,
    });
    return transformedBody;
  }

  _replaceResponseBody(response, body) {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Peek first N bytes of SSE body to detect upstream transient errors / capacity.
   * Returns { matched, message, accountFallback, replacementBody, cancel }.
   */
  async _peekSseOverloaded(response, { buildReplacement = true } = {}) {
    if (!response || !response.ok || !response.body) {
      return {
        matched: null,
        message: null,
        accountFallback: false,
        replacementBody: null,
        cancel: null,
      };
    }
    const contentType = response.headers?.get?.("content-type") || "";
    if (contentType && !contentType.includes("text/event-stream")) {
      return {
        matched: null,
        message: null,
        accountFallback: false,
        replacementBody: null,
        cancel: null,
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let peekedBytes = 0;
    let pendingText = "";
    let matched = null;
    let matchedEvent = "";
    let accountFallback = false;
    try {
      peek: while (peekedBytes < CODEX_SSE_PEEK_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) {
          // The upstream may close right after its last event without the blank line.
          pendingText += decoder.decode();
        } else {
          chunks.push(value);
          peekedBytes += value.byteLength;
          pendingText += decoder.decode(value, { stream: true });
        }

        let separator;
        while (
          (separator = SSE_EVENT_SEPARATOR.exec(pendingText)) ||
          (done && pendingText.trim())
        ) {
          const rawEvent = separator
            ? pendingText.slice(0, separator.index)
            : pendingText;
          pendingText = separator
            ? pendingText.slice(separator.index + separator[0].length)
            : "";
          const event = classifyPeekedSseEvent(rawEvent);
          if (event.kind === "continue") continue;
          if (event.kind !== "pass") {
            matched = event.matched;
            matchedEvent = rawEvent;
            accountFallback = event.kind === "capacity";
          }
          break peek;
        }
        if (done) break;
      }
    } catch (readError) {
      // The upstream broke inside the peek window. Hand downstream a body that
      // replays what arrived and then fails the same way, so the stream handler
      // sees a broken stream instead of a body this reader still holds locked.
      reader.releaseLock();
      const brokenBody = new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.error(readError);
        },
      });
      return {
        matched: null,
        message: null,
        accountFallback: false,
        replacementBody: brokenBody,
        cancel: null,
      };
    }

    if (matched) {
      return {
        matched,
        message: extractSseErrorMessage(matchedEvent, matched),
        accountFallback,
        replacementBody: null,
        cancel: async (reason) => {
          try {
            await reader.cancel(reason);
          } finally {
            try {
              reader.releaseLock();
            } catch {
              /* noop */
            }
          }
        },
      };
    }

    if (!buildReplacement) {
      reader.releaseLock();
      return {
        matched: null,
        message: null,
        accountFallback: false,
        replacementBody: null,
        cancel: null,
      };
    }

    reader.releaseLock();

    const upstream = response.body;
    let upstreamReader = null;
    const replacementBody = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        upstreamReader = upstream.getReader();
      },
      async pull(controller) {
        try {
          const { done, value } = await upstreamReader.read();
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        try {
          upstreamReader?.cancel(reason);
        } catch {
          /* noop */
        }
      },
    });
    return {
      matched: null,
      message: null,
      accountFallback: false,
      replacementBody,
      cancel: (reason) => replacementBody.cancel(reason),
    };
  }

  parseError(response, bodyText) {
    if (response.status === 429 && bodyText) {
      try {
        const json = JSON.parse(bodyText);
        const error = json?.error;
        if (error?.type === "usage_limit_reached") {
          const now = Date.now();
          let resetsAtMs = null;
          if (typeof error.resets_at === "number" && error.resets_at > 0) {
            const epochMs = error.resets_at * 1000;
            if (epochMs > now) resetsAtMs = epochMs;
          }
          if (
            !resetsAtMs &&
            typeof error.resets_in_seconds === "number" &&
            error.resets_in_seconds > 0
          ) {
            resetsAtMs = now + error.resets_in_seconds * 1000;
          }
          if (resetsAtMs) {
            return {
              status: 429,
              message: error.message || bodyText,
              resetsAtMs,
            };
          }
        }
      } catch {}
    }
    return super.parseError(response, bodyText);
  }

  async execute(args) {
    const request = this.buildRequest(args);
    const imgCount = Array.isArray(args.body?.input)
      ? args.body.input.reduce(
          (n, it) =>
            n +
            (Array.isArray(it.content)
              ? it.content.filter((c) => c.type === "image_url").length
              : 0),
          0,
        )
      : 0;
    if (imgCount > 0) {
      await this.prefetchImages(request.transformedBody, args.proxyOptions);
    }
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    const retryEntry = resolveRetryEntry(retryConfig[503]);
    let attempt = 0;
    let response;
    while (true) {
      response = await BaseExecutor.prototype.execute.call(this, {
        ...args,
        body: structuredClone(request.transformedBody),
        credentials: {
          ...args.credentials,
          providerSpecificData: {
            ...(args.credentials?.providerSpecificData || {}),
            dispatchSessionId: request.sessionId,
            dispatchCompact: request.isCompact,
          },
        },
      });
      const peek = await this._peekSseOverloaded(response.response, {
        buildReplacement: true,
      });
      if (!peek.matched) {
        if (peek.replacementBody) {
          response.response = this._replaceResponseBody(
            response.response,
            peek.replacementBody,
          );
        }
        break;
      }

      // Capacity: surface as 503 so account fallback can rotate connections
      if (peek.accountFallback) {
        args.log?.warn?.(
          "RETRY",
          `CODEX | SSE account fallback "${peek.message || peek.matched}"`,
        );
        try {
          await peek.cancel?.("codex_sse_capacity_fallback");
        } catch {
          /* noop */
        }
        response.response = codexSseErrorResponse(
          HTTP_STATUS.SERVICE_UNAVAILABLE,
          peek.message || CODEX_MODEL_CAPACITY_MESSAGE,
        );
        break;
      }

      if (attempt >= retryEntry.attempts) {
        args.log?.warn?.(
          "RETRY",
          `CODEX | SSE overloaded "${peek.matched}" — retries exhausted (${attempt}/${retryEntry.attempts})`,
        );
        try {
          await peek.cancel?.("codex_sse_overloaded_exhausted");
        } catch {
          /* noop */
        }
        response.response = codexSseErrorResponse(
          HTTP_STATUS.SERVICE_UNAVAILABLE,
          peek.message || peek.matched,
        );
        break;
      }

      attempt++;
      args.log?.debug?.(
        "RETRY",
        `CODEX | SSE ${peek.matched} retry ${attempt}/${retryEntry.attempts}`,
      );
      try {
        await peek.cancel?.("codex_sse_overloaded_retry");
      } catch {
        /* noop */
      }
      await new Promise((resolve) => setTimeout(resolve, retryEntry.delayMs));
    }
    return {
      ...response,
      url: response.url,
      headers: request.headers,
      transformedBody: request.transformedBody,
      pathMode: response.pathMode,
      sessionId: request.sessionId,
      isCompact: request.isCompact,
    };
  }
}
