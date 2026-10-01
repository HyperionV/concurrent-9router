/**
 * Pure client-safe helper to infer reasoning efforts, context windows, and capabilities.
 * Zero Node.js or SQLite dependencies.
 */
export function resolveModelCapabilities(providerId = "", modelId = "", meta = {}) {
  const normId = (modelId || "").toLowerCase();
  const normProv = (providerId || "").toLowerCase();

  // Determine reasoning / thinking capabilities
  let reasoningEfforts = [];
  let defaultReasoningEffort = null;
  let hasReasoning = false;

  if (
    normProv.includes("grok") ||
    normProv === "gcli" ||
    normId.includes("grok-4") ||
    normId.includes("grok-build")
  ) {
    hasReasoning = true;
    reasoningEfforts = ["low", "medium", "high", "xhigh", "max"];
    defaultReasoningEffort = "high";
  } else if (
    normProv.includes("codex") ||
    normProv === "cx" ||
    normId.includes("gpt-6") ||
    normId.includes("gpt-5") ||
    normId.includes("codex") ||
    normId.includes("daybreak")
  ) {
    hasReasoning = true;
    reasoningEfforts = ["none", "low", "medium", "high", "xhigh"];
    defaultReasoningEffort = "high";
  } else if (
    normProv.includes("claude") ||
    normProv === "cc" ||
    normId.includes("claude-opus") ||
    normId.includes("claude-sonnet") ||
    normId.includes("claude-fable") ||
    normId.includes("claude-3-7")
  ) {
    hasReasoning = true;
    reasoningEfforts = ["low", "medium", "high", "max"];
    defaultReasoningEffort = "high";
  } else if (
    normProv.includes("gemini") ||
    normProv.includes("antigravity") ||
    normProv === "ag" ||
    normProv === "gc" ||
    normId.includes("gemini-2.5") ||
    normId.includes("gemini-3")
  ) {
    hasReasoning = true;
    reasoningEfforts = ["low", "medium", "high"];
    defaultReasoningEffort = "high";
  } else if (
    normId.includes("deepseek-r1") ||
    normId.includes("qwq") ||
    normId.includes("reasoning") ||
    normId.includes("r1")
  ) {
    hasReasoning = true;
    reasoningEfforts = ["high"];
    defaultReasoningEffort = "high";
  }

  // Determine context window
  let contextWindow = meta.contextLength || meta.context_length || meta.contextWindow;
  if (!contextWindow) {
    if (normId.includes("[1m]") || normId.includes("1m") || normId.includes("gemini-1.5") || normId.includes("gemini-2")) {
      contextWindow = 1000000;
    } else if (normId.includes("grok-build")) {
      contextWindow = 500000;
    } else if (
      normId.includes("claude") ||
      normId.includes("gpt-6") ||
      normId.includes("gpt-5")
    ) {
      contextWindow = 200000;
    } else if (normId.includes("grok-4")) {
      contextWindow = 131072;
    } else {
      contextWindow = 128000;
    }
  }

  // Determine max output tokens
  let maxOutputTokens = meta.maxOutputTokens || meta.max_output_tokens;
  if (!maxOutputTokens) {
    if (
      normId.includes("claude-opus-5") ||
      normId.includes("claude-sonnet-5") ||
      normId.includes("claude-5") ||
      normId.includes("gpt-6") ||
      normId.includes("gpt-5.6") ||
      normId.includes("gpt-5.5") ||
      normId.includes("grok-build") ||
      normId.includes("grok-4.7")
    ) {
      maxOutputTokens = 64000;
    } else if (normId.includes("claude") || normId.includes("gpt-5")) {
      maxOutputTokens = 16384;
    } else {
      maxOutputTokens = 8192;
    }
  }

  const isImageModel = meta.type === "image" || meta.kind === "image" || normId.includes("image") || normId.includes("dall-e");

  const capabilities = {
    reasoning: hasReasoning,
    vision: !isImageModel,
    tool_calling: !isImageModel,
    streaming: true,
    image_generation: isImageModel,
  };

  return {
    capabilities,
    reasoning_efforts: reasoningEfforts,
    default_reasoning_effort: defaultReasoningEffort,
    context_window: contextWindow,
    max_output_tokens: maxOutputTokens,
  };
}
