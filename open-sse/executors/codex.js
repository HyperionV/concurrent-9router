import { createHash } from "crypto";
import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { PROVIDERS } from "../config/providers.js";
import { normalizeResponsesInput } from "../translator/helpers/responsesApiHelper.js";
import { fetchImageAsBase64 } from "../translator/helpers/imageHelper.js";
import {
  DEFAULT_RETRY_CONFIG,
  resolveRetryEntry,
} from "../config/runtimeConfig.js";
import { getConsistentMachineId } from "../../src/shared/utils/machineId.js";

const CODEX_SSE_OVERLOADED_PATTERNS = [
  "server_is_overloaded",
  "service_unavailable_error",
];
const CODEX_SSE_PEEK_BYTES = 4096;
const SESSION_TTL_MS = 60 * 60 * 1000;
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;
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
]);
const RESPONSES_API_ALLOWLIST = new Set([
  "model",
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "stream",
  "store",
  "reasoning",
  "service_tier",
  "include",
  "prompt_cache_key",
  "client_metadata",
]);
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

function stripStoredItemReferences(body) {
  delete body.previous_response_id;
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (typeof item === "string" && SERVER_ID_PATTERN.test(item)) return false;
    if (item && typeof item === "object" && !Array.isArray(item)) {
      if (item.type === "item_reference") return false;
      if (typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id))
        delete item.id;
    }
    return true;
  });
}

function normalizeCodexTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
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
        }
      }
      return true;
    }
    if (type !== "function") {
      if (!type || tool.function || typeof tool.name === "string") return false;
      return CODEX_HOSTED_TOOL_TYPES.has(type);
    }
    const fn =
      tool.function &&
      typeof tool.function === "object" &&
      !Array.isArray(tool.function)
        ? tool.function
        : null;
    const rawName =
      typeof tool.name === "string"
        ? tool.name
        : typeof fn?.name === "string"
          ? fn.name
          : "";
    const name = rawName.trim().slice(0, 128);
    if (!name) return false;
    const description =
      typeof tool.description === "string"
        ? tool.description
        : typeof fn?.description === "string"
          ? fn.description
          : "";
    const parameters =
      tool.parameters &&
      typeof tool.parameters === "object" &&
      !Array.isArray(tool.parameters)
        ? tool.parameters
        : fn?.parameters &&
            typeof fn.parameters === "object" &&
            !Array.isArray(fn.parameters)
          ? fn.parameters
          : { type: "object", properties: {} };
    for (const key of Object.keys(tool)) delete tool[key];
    tool.type = "function";
    tool.name = name;
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(name);
    return true;
  });

  if (
    body.tool_choice &&
    typeof body.tool_choice === "object" &&
    !Array.isArray(body.tool_choice)
  ) {
    if (body.tool_choice.type === "function") {
      const name =
        typeof body.tool_choice.name === "string"
          ? body.tool_choice.name.trim()
          : "";
      if (!name || !validNames.has(name)) delete body.tool_choice;
    }
  }
}

function applyResponsesApiAllowlist(body) {
  for (const key of Object.keys(body)) {
    if (!RESPONSES_API_ALLOWLIST.has(key)) delete body[key];
  }
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

    // Extract thinking level from model name suffix
    // e.g., gpt-5.3-codex-high → high, gpt-5.3-codex → medium (default)
    const effortLevels = ["none", "low", "medium", "high", "xhigh"];
    let modelEffort = null;
    let requestModel = model;
    for (const level of effortLevels) {
      if (model.endsWith(`-${level}`)) {
        modelEffort = level;
        // Strip suffix from model name for actual API call
        requestModel = model.replace(`-${level}`, "");
        break;
      }
    }
    workingBody.model = requestModel;

    // Priority: explicit reasoning.effort > reasoning_effort param > model suffix > default (medium)
    if (!workingBody.reasoning) {
      const effort = workingBody.reasoning_effort || modelEffort || "low";
      workingBody.reasoning = { effort, summary: "auto" };
    } else if (!workingBody.reasoning.summary) {
      workingBody.reasoning.summary = "auto";
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

    if (!workingBody.prompt_cache_key && resolvedSessionId) {
      workingBody.prompt_cache_key = resolvedSessionId;
    }
    applyResponsesApiAllowlist(workingBody);

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

  _replaceResponseBody(response, body) {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async _peekSseOverloaded(response, { buildReplacement = true } = {}) {
    if (!response || !response.ok || !response.body)
      return { matched: null, replacementBody: null, cancel: null };
    const contentType = response.headers?.get?.("content-type") || "";
    if (contentType && !contentType.includes("text/event-stream")) {
      return { matched: null, replacementBody: null, cancel: null };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let text = "";
    let matched = null;
    try {
      while (text.length < CODEX_SSE_PEEK_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        text += decoder.decode(value, { stream: true });
        matched =
          CODEX_SSE_OVERLOADED_PATTERNS.find((pattern) =>
            text.includes(pattern),
          ) || null;
        if (matched) break;
      }
    } catch {
      return { matched: null, replacementBody: null, cancel: null };
    }

    if (matched && !buildReplacement) {
      return {
        matched,
        replacementBody: null,
        cancel: async (reason) => {
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
          }
        },
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
        } catch {}
      },
    });
    return {
      matched,
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
    await this.prefetchImages(request.transformedBody, args.proxyOptions);
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
        buildReplacement: attempt >= retryEntry.attempts,
      });
      if (!peek.matched) {
        if (peek.replacementBody)
          response.response = this._replaceResponseBody(
            response.response,
            peek.replacementBody,
          );
        break;
      }
      if (attempt >= retryEntry.attempts) {
        if (peek.replacementBody)
          response.response = this._replaceResponseBody(
            response.response,
            peek.replacementBody,
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
      } catch {}
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
