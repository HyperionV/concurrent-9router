// Provider definitions

export const FREE_PROVIDERS = {
  opencode: {
    id: "opencode",
    alias: "oc",
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
    noAuth: true,
    hasFree: true,
    passthroughModels: true,
    website: "https://opencode.ai",
  },
};

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
    serviceKinds: ["llm", "image"],
    kindNotice: {
      image:
        "Requires a ChatGPT Plus (or higher) account. Free accounts are not supported for image generation.",
    },
  },
  antigravity: {
    id: "antigravity",
    alias: "ag",
    name: "Antigravity",
    icon: "rocket_launch",
    color: "#F59E0B",
    website: "https://antigravity.google",
    notice: {
      text: "Google Cloud Code / Antigravity OAuth. Upstream marks this provider as higher-risk; use with care.",
      signupUrl: "https://antigravity.google",
    },
  },
  "grok-cli": {
    id: "grok-cli",
    alias: "gcli",
    name: "Grok CLI (Grok Build)",
    icon: "auto_awesome",
    color: "#1DA1F2",
    textIcon: "GC",
    website: "https://x.ai",
    thinkingConfig: {
      options: ["low", "medium", "high"],
      defaultMode: "high",
    },
    notice: {
      text: "Sign in with your xAI / Grok account via device code. Uses Grok Build subscription credits (cli-chat-proxy.grok.com).",
      signupUrl: "https://grok.com/supergrok",
    },
  },
  kimi: {
    id: "kimi",
    alias: "kimi",
    name: "Kimi",
    icon: "psychology",
    color: "#1E3A8A",
    textIcon: "KM",
    website: "https://kimi.moonshot.cn",
    authModes: ["oauth", "apikey"],
    hasOAuth: true,
    serviceKinds: ["llm", "webSearch"],
    notice: {
      apiKeyUrl: "https://platform.moonshot.ai/console/api-keys",
      signupUrl: "https://www.kimi.com/code",
    },
  },
  "kimi-coding": {
    id: "kimi-coding",
    alias: "kmc",
    name: "Kimi Coding",
    icon: "psychology",
    color: "#1E3A8A",
    textIcon: "KM",
    website: "https://kimi.moonshot.cn",
    authModes: ["oauth", "apikey"],
    hasOAuth: true,
    serviceKinds: ["llm", "webSearch"],
  },
  qwen: {
    id: "qwen",
    alias: "qwen",
    name: "Qwen (Alibaba)",
    icon: "cloud",
    color: "#FF6A00",
    textIcon: "QW",
    website: "https://chat.qwen.ai",
    authModes: ["oauth", "apikey"],
    hasOAuth: true,
    serviceKinds: ["llm", "embedding"],
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
  glm: {
    id: "glm",
    alias: "glm",
    name: "GLM Coding (Z.ai)",
    icon: "code",
    color: "#2563EB",
    textIcon: "GL",
    website: "https://open.bigmodel.cn",
    serviceKinds: ["llm", "webSearch"],
    notice: {
      apiKeyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    },
  },
  zai: {
    id: "zai",
    alias: "zai",
    name: "Z.ai (GLM)",
    icon: "code",
    color: "#2563EB",
    textIcon: "ZA",
    website: "https://z.ai",
    serviceKinds: ["llm", "webSearch"],
  },
  alicode: {
    id: "alicode",
    alias: "alicode",
    name: "Alibaba DashScope (Bailian)",
    icon: "cloud",
    color: "#FF6A00",
    textIcon: "ALi",
    website: "https://bailian.console.aliyun.com",
    serviceKinds: ["llm", "embedding"],
    notice: {
      apiKeyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
    },
  },
  "opencode-go": {
    id: "opencode-go",
    alias: "ocg",
    name: "OpenCode Go",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
    website: "https://opencode.ai/auth",
    serviceKinds: ["llm"],
    notice: {
      text: "OpenCode Go subscription: Access to Kimi, GLM, Qwen, MiMo, MiniMax models.",
      apiKeyUrl: "https://opencode.ai/auth",
    },
  },
  "xiaomi-mimo": {
    id: "xiaomi-mimo",
    alias: "mimo",
    name: "Xiaomi MiMo",
    icon: "smart_toy",
    color: "#FF6900",
    textIcon: "XM",
    website: "https://xiaomimimo.com",
    serviceKinds: ["llm", "tts"],
    notice: {
      apiKeyUrl: "https://platform.xiaomimimo.com/console/api-keys",
    },
  },
  mimo: {
    id: "mimo",
    alias: "mimo",
    name: "Xiaomi MiMo",
    icon: "smart_toy",
    color: "#FF6900",
    textIcon: "XM",
    website: "https://xiaomimimo.com",
    serviceKinds: ["llm", "tts"],
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

export const MEDIA_PROVIDER_KINDS = [
  {
    id: "image",
    label: "Text to Image",
    icon: "brush",
    endpoint: { method: "POST", path: "/v1/images/generations" },
  },
];

// Providers that support usage/quota API
export const USAGE_SUPPORTED_PROVIDERS = [
  "claude",
  "antigravity",
  "kiro",
  "github",
  "codex",
  "kimi-coding",
  "grok-cli",
];
