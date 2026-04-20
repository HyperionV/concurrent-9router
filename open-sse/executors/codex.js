import { BaseExecutor } from "./base.js";
import { CODEX_DEFAULT_INSTRUCTIONS } from "../config/codexInstructions.js";
import { PROVIDERS } from "../config/providers.js";
import { normalizeResponsesInput } from "../translator/helpers/responsesApiHelper.js";
import { fetchImageAsBase64 } from "../translator/helpers/imageHelper.js";

function generateSessionId() {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

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
    headers.session_id =
      credentials?.providerSpecificData?.dispatchSessionId ||
      credentials?.connectionId ||
      generateSessionId();
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
    delete workingBody.user; // Cursor sends this but Codex doesn't support it
    delete workingBody.prompt_cache_retention; // Cursor sends this but Codex doesn't support it
    delete workingBody.metadata; // Cursor sends this but Codex doesn't support it
    delete workingBody.stream_options; // Cursor sends this but Codex doesn't support it
    delete workingBody.safety_identifier; // Droid CLI sends this but Codex doesn't support it

    const url = isCompact
      ? `${super.buildUrl(model, stream, 0, credentials)}/compact`
      : super.buildUrl(model, stream, 0, credentials);
    const headers = super.buildHeaders(credentials, stream);
    headers.session_id =
      sessionId ||
      credentials?.providerSpecificData?.dispatchSessionId ||
      credentials?.connectionId ||
      generateSessionId();

    return {
      url,
      headers,
      transformedBody: workingBody,
      sessionId: headers.session_id,
      isCompact,
    };
  }

  async execute(args) {
    const request = this.buildRequest(args);
    await this.prefetchImages(request.transformedBody, args.proxyOptions);
    const response = await super.execute({
      ...args,
      body: request.transformedBody,
      credentials: {
        ...args.credentials,
        providerSpecificData: {
          ...(args.credentials?.providerSpecificData || {}),
          dispatchSessionId: request.sessionId,
          dispatchCompact: request.isCompact,
        },
      },
    });
    return {
      ...response,
      url: response.url,
      headers: {
        ...response.headers,
        session_id: request.sessionId,
      },
      transformedBody: request.transformedBody,
      pathMode: response.pathMode,
      sessionId: request.sessionId,
      isCompact: request.isCompact,
    };
  }
}
