import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS } from "@/shared/constants/models";
import {
  AI_PROVIDERS,
  getProviderAlias,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
} from "@/shared/constants/providers";
import { getProviderConnections, getCombos } from "@/lib/localDb";

const UPSTREAM_CONNECTION_RE = /[-_][0-9a-f]{8,}$/i;

/**
 * Infer supported reasoning efforts and capabilities for a model.
 */
export function resolveModelCapabilities(providerId, modelId, meta = {}) {
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
  let contextWindow = meta.contextLength || meta.context_length;
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

/**
 * Fetch all publicly advertised models formatted with rich metadata.
 */
export async function getPublicModelsList() {
  let connections = [];
  try {
    connections = await getProviderConnections();
    connections = connections.filter((c) => c.isActive !== false);
  } catch (e) {
    console.log("Could not fetch provider connections for public models:", e?.message);
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos for public models:", e?.message);
  }

  const activeConnectionByProvider = new Map();
  for (const conn of connections) {
    if (!activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
  }

  const modelsList = [];
  const timestamp = Math.floor(Date.now() / 1000);

  // 1. Process Combos
  for (const combo of combos) {
    modelsList.push({
      id: combo.name,
      name: combo.name,
      description: `Virtual combo aggregating ${combo.models?.length || 0} upstream model(s)`,
      provider: "combo",
      provider_display: "Combo Aggregator",
      provider_alias: "combo",
      context_window: 200000,
      max_output_tokens: 32000,
      capabilities: {
        reasoning: true,
        vision: true,
        tool_calling: true,
        streaming: true,
        image_generation: false,
      },
      reasoning_efforts: ["low", "medium", "high", "xhigh"],
      default_reasoning_effort: "high",
      type: "combo",
      available: true,
      models_count: combo.models?.length || 0,
      created: timestamp,
    });
  }

  // 2. Process Providers
  const hasActiveProviders = activeConnectionByProvider.size > 0;

  if (!hasActiveProviders) {
    // If no active connections configured, advertise all standard catalogue models with available=false
    for (const [alias, providerModelsList] of Object.entries(PROVIDER_MODELS)) {
      const providerConfig = Object.values(AI_PROVIDERS).find(
        (p) => p.alias === alias || p.id === alias
      );
      const providerDisplay = providerConfig?.name || alias.toUpperCase();
      const providerId = providerConfig?.id || alias;

      for (const model of providerModelsList) {
        const fullId = `${alias}/${model.id}`;
        const caps = resolveModelCapabilities(providerId, model.id, model);

        modelsList.push({
          id: fullId,
          base_id: model.id,
          name: model.name || model.id,
          provider: providerId,
          provider_display: providerDisplay,
          provider_alias: alias,
          context_window: caps.context_window,
          max_output_tokens: caps.max_output_tokens,
          capabilities: caps.capabilities,
          reasoning_efforts: caps.reasoning_efforts,
          default_reasoning_effort: caps.default_reasoning_effort,
          type: model.type || "llm",
          available: false,
          created: timestamp,
        });
      }
    }
  } else {
    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix ||
        getProviderAlias(providerId) ||
        staticAlias
      ).trim();

      const providerConfig = AI_PROVIDERS[providerId] || {};
      const providerDisplay = providerConfig.name || providerId;
      const staticModels = PROVIDER_MODELS[staticAlias] || [];
      const enabledModels = conn?.providerSpecificData?.enabledModels;
      const hasExplicitEnabledModels =
        Array.isArray(enabledModels) && enabledModels.length > 0;

      let modelEntries = [];

      if (hasExplicitEnabledModels) {
        modelEntries = enabledModels
          .filter((id) => typeof id === "string" && id.trim() !== "")
          .map((id) => {
            const cleanId = id.startsWith(`${outputAlias}/`)
              ? id.slice(outputAlias.length + 1)
              : id.startsWith(`${staticAlias}/`)
              ? id.slice(staticAlias.length + 1)
              : id;
            const existingMeta = staticModels.find((m) => m.id === cleanId);
            return existingMeta || { id: cleanId, name: cleanId };
          });
      } else {
        modelEntries = staticModels;
      }

      for (const model of modelEntries) {
        const fullId = `${outputAlias}/${model.id}`;
        const caps = resolveModelCapabilities(providerId, model.id, model);

        modelsList.push({
          id: fullId,
          base_id: model.id,
          name: model.name || model.id,
          provider: providerId,
          provider_display: providerDisplay,
          provider_alias: outputAlias,
          context_window: caps.context_window,
          max_output_tokens: caps.max_output_tokens,
          capabilities: caps.capabilities,
          reasoning_efforts: caps.reasoning_efforts,
          default_reasoning_effort: caps.default_reasoning_effort,
          type: model.type || "llm",
          available: true,
          created: timestamp,
        });
      }
    }
  }

  return {
    object: "list",
    updated_at: timestamp,
    total_models: modelsList.length,
    data: modelsList,
  };
}
