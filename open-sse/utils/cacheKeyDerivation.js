import { createHash } from "node:crypto";

/**
 * Derives a canonical, deterministic cache key from the invariant prefix
 * of an LLM request (model + sorted tool definitions + system/developer prompt).
 * Subsequent user and assistant messages are deliberately excluded so that
 * independent tasks sharing the same system prompt and tools reuse the same
 * warm upstream KV-cache on xAI Grok and OpenAI Codex.
 *
 * @param {object} body - Incoming request body
 * @returns {string|null} - 'pck_<hex16>' or explicit key, or null if no invariant prefix
 */
export function deriveStablePrefixCacheKey(body = {}) {
  if (!body || typeof body !== "object") return null;

  if (
    typeof body.prompt_cache_key === "string" &&
    body.prompt_cache_key.trim()
  ) {
    return body.prompt_cache_key.trim();
  }

  const parts = [];

  const model = String(body.model || "").trim().toLowerCase();
  if (model) parts.push(`model=${model}`);

  const rawTools = Array.isArray(body.tools)
    ? body.tools
    : Array.isArray(body.functions)
      ? body.functions
      : [];

  if (rawTools.length > 0) {
    const serializedTools = rawTools
      .map((t) => {
        if (!t || typeof t !== "object") return "";
        const fn = t.function || t;
        const name = String(fn.name || t.name || "").trim();
        const desc = String(fn.description || t.description || "").trim();
        const params = fn.parameters ? JSON.stringify(fn.parameters) : "";
        return `${name}:${desc}:${params}`;
      })
      .filter(Boolean)
      .sort()
      .join("|");
    if (serializedTools) parts.push(`tools=${serializedTools}`);
  }

  let systemText = "";
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    systemText = body.instructions.trim();
  } else if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== "object") continue;
      const role = String(msg.role || "").trim();
      if (role === "system" || role === "developer") {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content
                  .map((c) =>
                    c && typeof c === "object" ? c.text || "" : "",
                  )
                  .join("")
              : "";
        systemText += content;
      }
    }
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      const role = String(item.role || "").trim();
      if (role === "system" || role === "developer") {
        const content = typeof item.content === "string" ? item.content : "";
        systemText += content;
      }
    }
  }

  if (systemText.trim()) {
    parts.push(`system=${systemText.trim()}`);
  }

  // Must have substantive prompt content (system instructions or tool declarations)
  // to avoid tenant-wide model-only collisions.
  const hasContent = systemText.trim().length > 0 || (rawTools && rawTools.length > 0);
  if (!hasContent) return null;

  const digest = createHash("sha256")
    .update(parts.join("||"))
    .digest("hex")
    .slice(0, 16);

  return `pck_${digest}`;
}
