// Provider definitions

export const FREE_PROVIDERS = {};

export const FREE_TIER_PROVIDERS = {};

// Thinking config definitions
// options: list of selectable modes ("auto" = no override from server)
// defaultMode: fallback when user hasn't configured
// extended: claude-style thinking (thinking.type + budget_tokens) — used by most providers
// effort: openai-style reasoning_effort — only openai + codex
export const THINKING_CONFIG = {
  extended: {
    options: ["auto", "on", "off"],
    defaultMode: "auto",
    defaultBudgetTokens: 10000,
  },
  effort: {
    options: ["auto", "none", "low", "medium", "high"],
    defaultMode: "auto",
  },
};

// OAuth Providers
export const OAUTH_PROVIDERS = {
  claude: {
    id: "claude",
    alias: "cc",
    name: "Claude Code",
    icon: "smart_toy",
    color: "#D97757",
  },
  codex: {
    id: "codex",
    alias: "cx",
    name: "OpenAI Codex",
    icon: "code",
    color: "#3B82F6",
    thinkingConfig: THINKING_CONFIG.effort,
  },
};

export const APIKEY_PROVIDERS = {
  openai: {
    id: "openai",
    alias: "openai",
    name: "OpenAI",
    icon: "auto_awesome",
    color: "#10A37F",
    textIcon: "OA",
    website: "https://platform.openai.com",
    serviceKinds: [
      "llm",
      "embedding",
      "tts",
      "image",
      "imageToText",
      "webSearch",
    ],
    thinkingConfig: THINKING_CONFIG.effort,
  },
  anthropic: {
    id: "anthropic",
    alias: "anthropic",
    name: "Anthropic",
    icon: "smart_toy",
    color: "#D97757",
    textIcon: "AN",
    website: "https://console.anthropic.com",
    serviceKinds: ["llm", "imageToText"],
  },
};

export const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";
export const ANTHROPIC_COMPATIBLE_PREFIX = "anthropic-compatible-";

export function isOpenAICompatibleProvider(providerId) {
  return (
    typeof providerId === "string" &&
    providerId.startsWith(OPENAI_COMPATIBLE_PREFIX)
  );
}

export function isAnthropicCompatibleProvider(providerId) {
  return (
    typeof providerId === "string" &&
    providerId.startsWith(ANTHROPIC_COMPATIBLE_PREFIX)
  );
}

// All providers (combined)
export const AI_PROVIDERS = {
  ...FREE_PROVIDERS,
  ...FREE_TIER_PROVIDERS,
  ...OAUTH_PROVIDERS,
  ...APIKEY_PROVIDERS,
};

// Auth methods
export const AUTH_METHODS = {
  oauth: { id: "oauth", name: "OAuth", icon: "lock" },
  apikey: { id: "apikey", name: "API Key", icon: "key" },
};

// Helper: Get provider by alias
export function getProviderByAlias(alias) {
  for (const provider of Object.values(AI_PROVIDERS)) {
    if (provider.alias === alias || provider.id === alias) {
      return provider;
    }
  }
  return null;
}

// Helper: Get provider ID from alias
export function resolveProviderId(aliasOrId) {
  const provider = getProviderByAlias(aliasOrId);
  return provider?.id || aliasOrId;
}

// Helper: Get alias from provider ID
export function getProviderAlias(providerId) {
  const provider = AI_PROVIDERS[providerId];
  return provider?.alias || providerId;
}

// Alias to ID mapping (for quick lookup)
export const ALIAS_TO_ID = Object.values(AI_PROVIDERS).reduce((acc, p) => {
  acc[p.alias] = p.id;
  return acc;
}, {});

// ID to Alias mapping
export const ID_TO_ALIAS = Object.values(AI_PROVIDERS).reduce((acc, p) => {
  acc[p.id] = p.alias;
  return acc;
}, {});

// Helper: Get providers by service kind (e.g. "tts", "embedding", "image")
// Providers without serviceKinds default to ["llm"]
export function getProvidersByKind(kind) {
  return Object.values(AI_PROVIDERS).filter((p) => {
    const kinds = p.serviceKinds ?? ["llm"];
    if (!kinds.includes(kind)) return false;
    if (p.hidden) return false; // globally hidden
    if (p.hiddenKinds?.includes(kind)) return false; // hidden for specific kind
    return true;
  });
}

// Providers that support usage/quota API
export const USAGE_SUPPORTED_PROVIDERS = [
  "claude",
  "antigravity",
  "kiro",
  "github",
  "codex",
  "kimi-coding",
];
