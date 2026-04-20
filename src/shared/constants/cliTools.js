export const MITM_TOOLS = {};

// CLI Tools configuration
export const CLI_TOOLS = {
  claude: {
    id: "claude",
    name: "Claude Code",
    icon: "terminal",
    color: "#D97757",
    description: "Anthropic Claude Code CLI",
    configType: "env",
    envVars: {
      baseUrl: "ANTHROPIC_BASE_URL",
      model: "ANTHROPIC_MODEL",
      opusModel: "ANTHROPIC_DEFAULT_OPUS_MODEL",
      sonnetModel: "ANTHROPIC_DEFAULT_SONNET_MODEL",
      haikuModel: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    },
    modelAliases: ["default", "sonnet", "opus", "haiku", "opusplan"],
    settingsFile: "~/.claude/settings.json",
    defaultModels: [
      {
        id: "opus",
        name: "Claude Opus",
        alias: "opus",
        envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
        defaultValue: "cc/claude-opus-4-6",
      },
      {
        id: "sonnet",
        name: "Claude Sonnet",
        alias: "sonnet",
        envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
        defaultValue: "cc/claude-sonnet-4-6",
      },
      {
        id: "haiku",
        name: "Claude Haiku",
        alias: "haiku",
        envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        defaultValue: "cc/claude-haiku-4-5-20251001",
      },
    ],
  },
  codex: {
    id: "codex",
    name: "OpenAI Codex CLI",
    image: "/providers/codex.png",
    color: "#10A37F",
    description: "OpenAI Codex CLI",
    configType: "custom",
  },
};

// Get all provider models for mapping dropdown
export const getProviderModelsForMapping = (providers) => {
  const result = [];
  providers.forEach((conn) => {
    if (
      conn.isActive &&
      (conn.testStatus === "active" || conn.testStatus === "success")
    ) {
      result.push({
        connectionId: conn.id,
        provider: conn.provider,
        name: conn.name,
        models: conn.models || [],
      });
    }
  });
  return result;
};
