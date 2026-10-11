// Request-shaping rules that the Codex and Grok CLI executors share because both
// talk to a /responses backend. Provider-specific rules stay in each executor.

// Server-generated item ids that /responses cannot resolve when store=false
const SERVER_ID_PATTERN = /^(rs|fc|resp|msg)_/;

const EFFORT_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const EMPTY_FUNCTION_PARAMETERS = { type: "object", properties: {} };

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** True for input items that point at server-side stored state (cannot resolve with store=false). */
export function isStoredItemReference(item) {
  if (typeof item === "string") return SERVER_ID_PATTERN.test(item);
  return isPlainObject(item) && item.type === "item_reference";
}

/** True for input objects carrying a server-generated `id`. */
export function hasServerItemId(item) {
  return isPlainObject(item) && typeof item.id === "string" && SERVER_ID_PATTERN.test(item.id);
}

/**
 * Split a virtual model id such as "gpt-5.3-codex-high" into the upstream model
 * and the reasoning effort encoded in its suffix.
 */
export function splitEffortSuffix(modelId) {
  if (typeof modelId !== "string") return { model: modelId, effort: null };
  const effort = EFFORT_LEVELS.find((level) => modelId.endsWith(`-${level}`));
  if (!effort) return { model: modelId, effort: null };
  return { model: modelId.slice(0, -(effort.length + 1)), effort };
}

/**
 * Read name, description and parameters from a function tool in either the flat
 * Responses shape or the nested Chat Completions shape ({ function: {...} }).
 * The name is trimmed but not length-limited; callers apply their own limit.
 */
export function readFunctionTool(tool) {
  const fn = isPlainObject(tool.function) ? tool.function : null;
  const rawName = typeof tool.name === "string" ? tool.name : typeof fn?.name === "string" ? fn.name : "";
  const description =
    typeof tool.description === "string"
      ? tool.description
      : typeof fn?.description === "string"
        ? fn.description
        : "";
  const parameters = isPlainObject(tool.parameters)
    ? tool.parameters
    : isPlainObject(fn?.parameters)
      ? fn.parameters
      : EMPTY_FUNCTION_PARAMETERS;
  return { name: rawName.trim(), description, parameters };
}

/** Remove a forced function tool_choice whose tool did not survive normalization. */
export function dropUnresolvableToolChoice(body, validNames) {
  if (!isPlainObject(body.tool_choice) || body.tool_choice.type !== "function") return;
  const name = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
  if (!name || !validNames.has(name)) delete body.tool_choice;
}
