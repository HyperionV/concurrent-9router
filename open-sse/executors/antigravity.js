import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import {
  OAUTH_ENDPOINTS,
  ANTIGRAVITY_HEADERS,
  AG_DEFAULT_TOOLS,
  AG_TOOL_SUFFIX,
} from "../config/appConstants.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { deriveSessionId } from "../utils/sessionManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { DEFAULT_THINKING_AG_SIGNATURE } from "../config/defaultThinkingSignature.js";
import { getModelUpstreamId } from "../config/providerModels.js";

const MAX_RETRY_AFTER_MS = 10000;
const ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS = 15000;
const ANTIGRAVITY_IDE_REQUEST_ID_RE = /^agent\/[^/]+\/\d+\/[^/]+\/\d+$/;
const IMAGE_MODEL_PATTERNS = [/image/i, /imagen/i, /image-generation/i];

const ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS = [
  /high\s+traffic/i,
  /agent\s+(execution\s+)?terminated\s+due\s+to\s+error/i,
  /capacity/i,
  /temporarily\s+unavailable/i,
  /timeout/i,
  /stream\s+(ended|closed|terminated|interrupted)/i,
  /empty\s+response/i,
];
const ANTIGRAVITY_TRANSIENT_STATUSES = new Set([
  HTTP_STATUS.SERVER_ERROR,
  HTTP_STATUS.BAD_GATEWAY,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
  HTTP_STATUS.GATEWAY_TIMEOUT,
]);

function isImageModel(model) {
  if (!model) return false;
  return IMAGE_MODEL_PATTERNS.some((p) => p.test(model));
}

function parseImageConfig(model) {
  const config = { aspectRatio: "1:1" };
  const resMatch = String(model || "").match(/(\d+)x(\d+)$/);
  if (!resMatch) return config;
  const w = parseInt(resMatch[1], 10);
  const h = parseInt(resMatch[2], 10);
  if (w <= 16 && h <= 16) {
    config.aspectRatio = `${w}:${h}`;
    return config;
  }
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const d = gcd(w, h);
  config.aspectRatio = `${w / d}:${h / d}`;
  return config;
}

function uuidFromSeed(seed) {
  const bytes = crypto
    .createHash("sha256")
    .update(String(seed || "antigravity"))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildIdeRequestId({ body, request, credentials, model, requestType }) {
  if (ANTIGRAVITY_IDE_REQUEST_ID_RE.test(body?.requestId || "")) {
    return body.requestId;
  }
  const sessionId =
    request?.sessionId ||
    body?.request?.sessionId ||
    credentials?.connectionId ||
    credentials?.email ||
    "anonymous";
  const conversationId = uuidFromSeed(`antigravity:conversation:${sessionId}`);
  const trajectoryId = uuidFromSeed(
    `antigravity:trajectory:${sessionId}:${model}:${requestType}`,
  );
  const contentCount = Array.isArray(request?.contents)
    ? request.contents.length
    : 1;
  const step = Math.max(1, contentCount * 2 - 1);
  return `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`;
}

function resolveAgUpstreamModel(model) {
  return (
    getModelUpstreamId("ag", model) ||
    getModelUpstreamId("antigravity", model) ||
    model
  );
}

export class AntigravityExecutor extends BaseExecutor {
  constructor() {
    super("antigravity", PROVIDERS.antigravity);
  }

  buildUrl(model, stream, urlIndex = 0) {
    const baseUrls = this.getBaseUrls();
    const baseUrl = baseUrls[urlIndex] || baseUrls[0];
    // Image generation must use non-streaming generateContent
    const forceNonStream = isImageModel(model);
    const action =
      stream && !forceNonStream
        ? "streamGenerateContent?alt=sse"
        : "generateContent";
    return `${baseUrl}/v1internal:${action}`;
  }

  // Match official IDE: Authorization + User-Agent only (no router-only headers).
  buildHeaders(credentials, stream = true, sessionId = null) {
    void stream;
    void sessionId;
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${credentials.accessToken}`,
      "User-Agent":
        this.config.headers?.["User-Agent"] ||
        ANTIGRAVITY_HEADERS["User-Agent"],
    };
  }

  transformRequest(model, body, stream, credentials) {
    void stream;
    const projectId = credentials?.projectId || this.generateProjectId();
    const resolvedModel = resolveAgUpstreamModel(model);

    // ─── Image generation: simplified generateContent payload ───
    if (isImageModel(resolvedModel)) {
      const imageConfig = parseImageConfig(resolvedModel);
      const cleanModel = String(resolvedModel).replace(/-(\d+)x(\d+)$/, "");
      const contents = [];
      const srcContents = body.request?.contents || body.contents || [];
      for (const c of srcContents) {
        const textParts = (c.parts || [])
          .filter((p) => p.text !== undefined)
          .map((p) => ({ text: p.text }));
        if (textParts.length > 0) {
          contents.push({ role: c.role || "user", parts: textParts });
        }
      }
      const sessionId = deriveSessionId(
        credentials?.email || credentials?.connectionId,
      );
      const request = {
        contents,
        generationConfig: {
          temperature: 1.0,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
          imageConfig,
        },
        sessionId,
      };
      return {
        project: projectId,
        model: cleanModel,
        userAgent: "antigravity",
        requestType: "image_gen",
        requestId: buildIdeRequestId({
          body,
          request,
          credentials,
          model: cleanModel,
          requestType: "image_gen",
        }),
        request,
      };
    }

    // Fix contents for Claude models via Antigravity
    const contents = body.request?.contents?.map((c) => {
      let role = c.role;
      // functionResponse must be role "user" for Claude models
      if (c.parts?.some((p) => p.functionResponse)) {
        role = "user";
      }
      // Strip thought-only parts, keep thoughtSignature on functionCall parts (Gemini 3+ requires it)
      const parts = c.parts?.filter((p) => {
        if (p.thought && !p.functionCall) return false;
        if (p.thoughtSignature && !p.functionCall && !p.text) return false;
        return true;
      });
      // Backfill thoughtSignature on functionCall parts (Gemini 3+ rejects missing signatures)
      const needsBackfill =
        parts?.some((p) => p.functionCall && !p.thoughtSignature) ?? false;
      if (
        role !== c.role ||
        parts?.length !== c.parts?.length ||
        needsBackfill
      ) {
        return {
          ...c,
          role,
          parts: needsBackfill
            ? parts.map((p) =>
                p.functionCall && !p.thoughtSignature
                  ? { ...p, thoughtSignature: DEFAULT_THINKING_AG_SIGNATURE }
                  : p,
              )
            : parts,
        };
      }
      return c;
    });

    const transformedRequest = {
      ...body.request,
      ...(contents && { contents }),
      sessionId:
        body.request?.sessionId ||
        deriveSessionId(credentials?.email || credentials?.connectionId),
      safetySettings: undefined,
      toolConfig:
        body.request?.tools?.length > 0
          ? { functionCallingConfig: { mode: "VALIDATED" } }
          : body.request?.toolConfig,
    };

    return {
      ...body,
      project: projectId,
      model: resolvedModel,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: buildIdeRequestId({
        body,
        request: transformedRequest,
        credentials,
        model: resolvedModel,
        requestType: "agent",
      }),
      request: transformedRequest,
    };
  }

  async refreshCredentials(credentials, log) {
    if (!credentials.refreshToken) return null;

    try {
      const response = await fetch(OAUTH_ENDPOINTS.google.token, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: credentials.refreshToken,
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret
        })
      });

      if (!response.ok) return null;

      const tokens = await response.json();
      log?.info?.("TOKEN", "Antigravity refreshed");

      return {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || credentials.refreshToken,
        expiresIn: tokens.expires_in,
        projectId: credentials.projectId
      };
    } catch (error) {
      log?.error?.("TOKEN", `Antigravity refresh error: ${error.message}`);
      return null;
    }
  }

  generateProjectId() {
    const adj = ["useful", "bright", "swift", "calm", "bold"][Math.floor(Math.random() * 5)];
    const noun = ["fuze", "wave", "spark", "flow", "core"][Math.floor(Math.random() * 5)];
    return `${adj}-${noun}-${crypto.randomUUID().slice(0, 5)}`;
  }

  generateSessionId() {
    return crypto.randomUUID() + Date.now().toString();
  }

  parseRetryHeaders(headers) {
    if (!headers?.get) return null;

    const retryAfter = headers.get('retry-after');
    if (retryAfter) {
      const seconds = parseInt(retryAfter, 10);
      if (!isNaN(seconds) && seconds > 0) return seconds * 1000;

      const date = new Date(retryAfter);
      if (!isNaN(date.getTime())) {
        const diff = date.getTime() - Date.now();
        return diff > 0 ? diff : null;
      }
    }

    const resetAfter = headers.get('x-ratelimit-reset-after');
    if (resetAfter) {
      const seconds = parseInt(resetAfter, 10);
      if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
    }

    const resetTimestamp = headers.get('x-ratelimit-reset');
    if (resetTimestamp) {
      const ts = parseInt(resetTimestamp, 10) * 1000;
      const diff = ts - Date.now();
      return diff > 0 ? diff : null;
    }

    return null;
  }

  // Parse retry time from Antigravity error message body
  // Format: "Your quota will reset after 2h7m23s" or "1h30m" or "45m" or "30s"
  parseRetryFromErrorMessage(errorMessage) {
    if (!errorMessage || typeof errorMessage !== "string") return null;

    const match = errorMessage.match(/reset after (\d+h)?(\d+m)?(\d+s)?/i);
    if (!match) return null;

    let totalMs = 0;
    if (match[1]) totalMs += parseInt(match[1]) * 3600 * 1000; // hours
    if (match[2]) totalMs += parseInt(match[2]) * 60 * 1000; // minutes
    if (match[3]) totalMs += parseInt(match[3]) * 1000; // seconds

    return totalMs > 0 ? totalMs : null;
  }

  isTransientAntigravityError(status, message) {
    if (status === HTTP_STATUS.RATE_LIMITED) return true;
    if (ANTIGRAVITY_TRANSIENT_STATUSES.has(status)) return true;
    return ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS.some((pattern) =>
      pattern.test(message || ""),
    );
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const MAX_AUTO_RETRIES = 3;
    const MAX_RETRY_AFTER_RETRIES = 3;
    const retryAttemptsByUrl = {}; // Track retry attempts per URL
    const retryAfterAttemptsByUrl = {}; // Track Retry-After retries per URL
    const transientAttemptsByUrl = {};

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      const sessionId = transformedBody.request?.sessionId;
      const headers = this.buildHeaders(credentials, stream, sessionId);

      // Initialize retry counters for this URL
      if (!retryAttemptsByUrl[urlIndex]) {
        retryAttemptsByUrl[urlIndex] = 0;
      }
      if (!retryAfterAttemptsByUrl[urlIndex]) {
        retryAfterAttemptsByUrl[urlIndex] = 0;
      }
      if (!transientAttemptsByUrl[urlIndex]) {
        transientAttemptsByUrl[urlIndex] = 0;
      }

      try {
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(transformedBody),
          signal
        }, proxyOptions);

        if (
          response.status === HTTP_STATUS.RATE_LIMITED ||
          response.status === HTTP_STATUS.SERVICE_UNAVAILABLE ||
          ANTIGRAVITY_TRANSIENT_STATUSES.has(response.status)
        ) {
          // Try to get retry time from headers first
          let retryMs = this.parseRetryHeaders(response.headers);
          let errorMessage = "";

          // If no retry time in headers, try to parse from error message body
          if (!retryMs) {
            try {
              const errorBody = await response.clone().text();
              const errorJson = JSON.parse(errorBody);
              errorMessage =
                errorJson?.error?.message || errorJson?.message || "";
              retryMs = this.parseRetryFromErrorMessage(errorMessage);
            } catch (e) {
              // Ignore parse errors, will fall back to exponential backoff
            }
          }

          if (retryMs && retryMs <= MAX_RETRY_AFTER_MS && retryAfterAttemptsByUrl[urlIndex] < MAX_RETRY_AFTER_RETRIES) {
            retryAfterAttemptsByUrl[urlIndex]++;
            log?.debug?.("RETRY", `${response.status} with Retry-After: ${Math.ceil(retryMs / 1000)}s, waiting... (${retryAfterAttemptsByUrl[urlIndex]}/${MAX_RETRY_AFTER_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, retryMs));
            urlIndex--;
            continue;
          }

          // Auto retry only for 429 when retryMs is 0 or undefined
          if (response.status === HTTP_STATUS.RATE_LIMITED && (!retryMs || retryMs === 0) && retryAttemptsByUrl[urlIndex] < MAX_AUTO_RETRIES) {
            retryAttemptsByUrl[urlIndex]++;
            // Exponential backoff: 2s, 4s, 8s...
            const backoffMs = Math.min(1000 * (2 ** retryAttemptsByUrl[urlIndex]), MAX_RETRY_AFTER_MS);
            log?.debug?.("RETRY", `429 auto retry ${retryAttemptsByUrl[urlIndex]}/${MAX_AUTO_RETRIES} after ${backoffMs / 1000}s`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            urlIndex--;
            continue;
          }

          // Transient 5xx / capacity-style failures (upstream port)
          if (
            this.isTransientAntigravityError(response.status, errorMessage) &&
            transientAttemptsByUrl[urlIndex] < MAX_AUTO_RETRIES
          ) {
            transientAttemptsByUrl[urlIndex]++;
            const backoffMs = Math.min(
              1000 * 2 ** transientAttemptsByUrl[urlIndex],
              ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS,
            );
            log?.debug?.(
              "RETRY",
              `AG transient ${response.status} retry ${transientAttemptsByUrl[urlIndex]}/${MAX_AUTO_RETRIES} after ${backoffMs / 1000}s`,
            );
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            urlIndex--;
            continue;
          }

          log?.debug?.("RETRY", `${response.status}, Retry-After ${retryMs ? `too long (${Math.ceil(retryMs / 1000)}s)` : 'missing'}, trying fallback`);
          lastStatus = response.status;

          if (urlIndex + 1 < fallbackCount) {
            continue;
          }
        }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        lastError = error;
        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }

  /**
   * Cloak tools before sending to Antigravity provider (anti-ban):
   * - Rename client tools with _ide suffix
   * - Inject AG default decoy tools after client tools
   * Returns { cloakedBody, toolNameMap } where toolNameMap maps suffixed → original
   */
  static cloakTools(body) {
    const tools = body.request?.tools;
    if (!tools || tools.length === 0) {
      return { cloakedBody: body, toolNameMap: null };
    }

    const toolNameMap = new Map();
    const clientDeclarations = [];

    // First: collect renamed client tools
    for (const toolGroup of tools) {
      if (!toolGroup.functionDeclarations) continue;

      for (const func of toolGroup.functionDeclarations) {
        // Skip if already an AG default tool name
        if (AG_DEFAULT_TOOLS.has(func.name)) {
          clientDeclarations.push(func);
          continue;
        }

        const suffixed = `${func.name}${AG_TOOL_SUFFIX}`;
        toolNameMap.set(suffixed, func.name);
        clientDeclarations.push({ ...func, name: suffixed });
      }
    }

    // Client tools first, then AG decoy tools
    const allDeclarations = [...clientDeclarations, ...AG_DECOY_TOOLS];

    // Rename tool names in conversation history (contents)
    const cloakedContents = body.request?.contents?.map(msg => {
      if (!msg.parts) return msg;
      
      const cloakedParts = msg.parts.map(part => {
        // Rename functionCall.name
        if (part.functionCall && !AG_DEFAULT_TOOLS.has(part.functionCall.name)) {
          return {
            ...part,
            functionCall: {
              ...part.functionCall,
              name: `${part.functionCall.name}${AG_TOOL_SUFFIX}`
            }
          };
        }
        
        // Rename functionResponse.name
        if (part.functionResponse && !AG_DEFAULT_TOOLS.has(part.functionResponse.name)) {
          return {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              name: `${part.functionResponse.name}${AG_TOOL_SUFFIX}`
            }
          };
        }
        
        return part;
      });
      
      return { ...msg, parts: cloakedParts };
    });

    // Single functionDeclarations group: client tools first, then decoys
    return {
      cloakedBody: {
        ...body,
        request: {
          ...body.request,
          tools: [{ functionDeclarations: allDeclarations }],
          contents: cloakedContents || body.request.contents
        }
      },
      toolNameMap
    };
  }
}

// AG decoy tools — same names as AG native defaults, redirect to _ide suffixed tools
const AG_DECOY_TOOLS = [
  {
    name: "browser_subagent",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "command_status",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "find_by_name",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "generate_image",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "grep_search",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "list_dir",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "list_resources",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "mcp_sequential-thinking_sequentialthinking",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "multi_replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "notify_user",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_resource",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_terminal",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_url_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "run_command",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "search_web",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "send_command_input",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "task_boundary",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "view_content_chunk",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "view_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "write_to_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  }
];

export default AntigravityExecutor;
