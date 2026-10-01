import { listPublicModelRecords } from "@/lib/localDb";
import { resolveModelCapabilities } from "@/shared/utils/modelCapabilities.js";

export { resolveModelCapabilities };

/**
 * Fetch all user-created public models formatted for the public endpoint.
 * Only returns active models configured by the operator in SQLite.
 */
export async function getPublicModelsList() {
  let records = [];
  try {
    records = listPublicModelRecords(true); // only active
  } catch (error) {
    console.error("Failed to read public_models from SQLite:", error?.message);
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const data = records.map((record) => {
    return {
      id: record.targetModel || record.id,
      entry_id: record.id,
      name: record.name,
      description: record.description || "",
      provider: record.provider || "custom",
      provider_display: record.providerDisplay || record.provider || "Custom",
      context_window: record.contextWindow,
      max_output_tokens: record.maxOutputTokens,
      capabilities: record.capabilities || {
        reasoning: Array.isArray(record.reasoningEfforts) && record.reasoningEfforts.length > 0,
        vision: true,
        tool_calling: true,
        streaming: true,
        image_generation: false,
      },
      reasoning_efforts: Array.isArray(record.reasoningEfforts) ? record.reasoningEfforts : [],
      default_reasoning_effort: record.defaultEffort || (record.reasoningEfforts?.[0] ?? null),
      type: record.capabilities?.image_generation ? "image" : "llm",
      available: true,
      created: Math.floor(new Date(record.createdAt || Date.now()).getTime() / 1000),
      updated_at: Math.floor(new Date(record.updatedAt || Date.now()).getTime() / 1000),
    };
  });

  return {
    object: "list",
    updated_at: timestamp,
    total_models: data.length,
    data,
  };
}
