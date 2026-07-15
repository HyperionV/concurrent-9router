/**
 * Usage Fetcher - Get usage data from provider APIs
 */

import { CLIENT_METADATA, getPlatformUserAgent } from "../config/appConstants.js";
import {
  GROK_CLI_USER_AGENT,
  GROK_CLI_TOKEN_AUTH,
  GROK_CLI_CLIENT_IDENTIFIER,
  GROK_CLI_CLIENT_VERSION,
} from "../config/providers.js";

// GitHub API config
const GITHUB_CONFIG = {
  apiVersion: "2022-11-28",
  userAgent: "GitHubCopilotChat/0.26.7",
};

// Antigravity API config (from Quotio)
const ANTIGRAVITY_CONFIG = {
  quotaApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  loadProjectApiUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  userAgent: getPlatformUserAgent(),
};

// Codex (OpenAI) API config
const CODEX_CONFIG = {
  usageUrl: "https://chatgpt.com/backend-api/wham/usage",
};

// Claude API config
const CLAUDE_CONFIG = {
  oauthUsageUrl: "https://api.anthropic.com/api/oauth/usage",
  usageUrl: "https://api.anthropic.com/v1/organizations/{org_id}/usage",
  settingsUrl: "https://api.anthropic.com/v1/settings",
  apiVersion: "2023-06-01",
};

/**
 * Get usage data for a provider connection
 * @param {Object} connection - Provider connection with accessToken
 * @returns {Object} Usage data with quotas
 */
export async function getUsageForProvider(connection) {
  const { provider, accessToken, providerSpecificData } = connection;

  switch (provider) {
    case "github":
      return await getGitHubUsage(accessToken, providerSpecificData);
    case "gemini-cli":
      return await getGeminiUsage(accessToken);
    case "antigravity":
      return await getAntigravityUsage(accessToken);
    case "claude":
      return await getClaudeUsage(accessToken);
    case "codex":
      return await getCodexUsage(accessToken);
    case "kiro":
      return await getKiroUsage(accessToken, providerSpecificData);
    case "qwen":
      return await getQwenUsage(accessToken, providerSpecificData);
    case "iflow":
      return await getIflowUsage(accessToken);
    case "grok-cli":
    case "gcli":
    case "gb":
    case "grok-build":
      return await getGrokCliUsage(accessToken, providerSpecificData);
    default:
      return { message: `Usage API not implemented for ${provider}` };
  }
}

/**
 * Parse reset date/time to ISO string
 * Handles multiple formats: Unix timestamp (ms), ISO date string, etc.
 */
function parseResetTime(resetValue) {
  if (!resetValue) return null;

  try {
    // If it's already a Date object
    if (resetValue instanceof Date) {
      return resetValue.toISOString();
    }

    // If it's a number (Unix timestamp in milliseconds)
    if (typeof resetValue === 'number') {
      return new Date(resetValue).toISOString();
    }

    // If it's a string (ISO date or any parseable date string)
    if (typeof resetValue === 'string') {
      return new Date(resetValue).toISOString();
    }

    return null;
  } catch (error) {
    console.warn(`Failed to parse reset time: ${resetValue}`, error);
    return null;
  }
}

/**
 * GitHub Copilot Usage
 * Uses GitHub accessToken (not copilotToken) to call copilot_internal/user API
 */
async function getGitHubUsage(accessToken, providerSpecificData) {
  try {
    if (!accessToken) {
      throw new Error("No GitHub access token available. Please re-authorize the connection.");
    }

    // copilot_internal/user API requires GitHub OAuth token, not copilotToken
    const response = await fetch("https://api.github.com/copilot_internal/user", {
      headers: {
        "Authorization": `token ${accessToken}`,
        "Accept": "application/json",
        "X-GitHub-Api-Version": GITHUB_CONFIG.apiVersion,
        "User-Agent": GITHUB_CONFIG.userAgent,
        "Editor-Version": "vscode/1.100.0",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
      },
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`GitHub API error: ${error}`);
    }

    const data = await response.json();

    // Handle different response formats (paid vs free)
    if (data.quota_snapshots) {
      // Paid plan format
      const snapshots = data.quota_snapshots;
      const resetAt = parseResetTime(data.quota_reset_date);

      return {
        plan: data.copilot_plan,
        resetDate: data.quota_reset_date,
        quotas: {
          chat: { ...formatGitHubQuotaSnapshot(snapshots.chat), resetAt },
          completions: { ...formatGitHubQuotaSnapshot(snapshots.completions), resetAt },
          premium_interactions: { ...formatGitHubQuotaSnapshot(snapshots.premium_interactions), resetAt },
        },
      };
    } else if (data.monthly_quotas || data.limited_user_quotas) {
      // Free/limited plan format
      const monthlyQuotas = data.monthly_quotas || {};
      const usedQuotas = data.limited_user_quotas || {};
      const resetAt = parseResetTime(data.limited_user_reset_date);

      return {
        plan: data.copilot_plan || data.access_type_sku,
        resetDate: data.limited_user_reset_date,
        quotas: {
          chat: {
            used: usedQuotas.chat || 0,
            total: monthlyQuotas.chat || 0,
            unlimited: false,
            resetAt,
          },
          completions: {
            used: usedQuotas.completions || 0,
            total: monthlyQuotas.completions || 0,
            unlimited: false,
            resetAt,
          },
        },
      };
    }

    return { message: "GitHub Copilot connected. Unable to parse quota data." };
  } catch (error) {
    throw new Error(`Failed to fetch GitHub usage: ${error.message}`);
  }
}

function formatGitHubQuotaSnapshot(quota) {
  if (!quota) return { used: 0, total: 0, unlimited: true };

  return {
    used: quota.entitlement - quota.remaining,
    total: quota.entitlement,
    remaining: quota.remaining,
    unlimited: quota.unlimited || false,
  };
}

/**
 * Gemini CLI Usage (Google Cloud)
 */
async function getGeminiUsage(accessToken) {
  try {
    // Gemini CLI uses Google Cloud quotas
    // Try to get quota info from Cloud Resource Manager
    const response = await fetch(
      "https://cloudresourcemanager.googleapis.com/v1/projects?filter=lifecycleState:ACTIVE",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );

    if (!response.ok) {
      // Quota API may not be accessible, return generic message
      return { message: "Gemini CLI uses Google Cloud quotas. Check Google Cloud Console for details." };
    }

    return { message: "Gemini CLI connected. Usage tracked via Google Cloud Console." };
  } catch (error) {
    return { message: "Unable to fetch Gemini usage. Check Google Cloud Console." };
  }
}

/**
 * Antigravity Usage - Fetch quota from Google Cloud Code API
 */
async function getAntigravityUsage(accessToken, providerSpecificData) {
  try {
    // Fetch subscription info once — reuse for both projectId and plan
    const subscriptionInfo = await getAntigravitySubscriptionInfo(accessToken);
    const projectId = subscriptionInfo?.cloudaicompanionProject || null;

    // Fetch quota data with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    let response;
    try {
      response = await fetch(ANTIGRAVITY_CONFIG.quotaApiUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
          "Content-Type": "application/json",
          "X-Client-Name": "antigravity",
          "X-Client-Version": "1.107.0",
          "x-request-source": "local", // MITM bypass
        },
        body: JSON.stringify({
          ...(projectId ? { project: projectId } : {})
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.status === 403) {
      return {
        message: "Antigravity quota API access forbidden. Chat may still work.",
        quotas: {}
      };
    }

    if (response.status === 401) {
      return {
        message: "Antigravity quota API authentication expired. Chat may still work.",
        quotas: {}
      };
    }

    if (!response.ok) {
      throw new Error(`Antigravity API error: ${response.status}`);
    }

    const data = await response.json();
    const quotas = {};

    // Parse model quotas (inspired by vscode-antigravity-cockpit)
    if (data.models) {
      // Filter only recommended/important models (must match PROVIDER_MODELS ag ids)
      const importantModels = [
        "claude-opus-4-6-thinking",
        "claude-sonnet-4-6",
        "gemini-3-flash-agent",
        "gemini-3.5-flash-low",
        "gemini-3.5-flash-extra-low",
        "gemini-pro-agent",
        "gemini-3.1-pro-low",
        "gemini-3.1-pro-high", // legacy alias still may appear in quota keys
        "gemini-3-flash",
        "gemini-3.1-flash-image",
        "gpt-oss-120b-medium",
      ];

      for (const [modelKey, info] of Object.entries(data.models)) {
        // Skip models without quota info
        if (!info.quotaInfo) {
          continue;
        }

        // Skip internal models and non-important models
        if (info.isInternal || !importantModels.includes(modelKey)) {
          continue;
        }

        const remainingFraction = info.quotaInfo.remainingFraction || 0;
        const remainingPercentage = remainingFraction * 100;

        // Convert percentage to used/total for UI compatibility
        const total = 1000; // Normalized base
        const remaining = Math.round(total * remainingFraction);
        const used = total - remaining;

        // Use modelKey as key (matches PROVIDER_MODELS id)
        quotas[modelKey] = {
          used,
          total,
          resetAt: parseResetTime(info.quotaInfo.resetTime),
          remainingPercentage,
          unlimited: false,
          displayName: info.displayName || modelKey,
        };
      }
    }

    return {
      plan: subscriptionInfo?.currentTier?.name || "Unknown",
      quotas,
      subscriptionInfo,
    };
  } catch (error) {
    console.error("[Antigravity Usage] Error:", error.message, error.cause);
    return { message: `Antigravity error: ${error.message}` };
  }
}

/**
 * Get Antigravity project ID from subscription info
 */
async function getAntigravityProjectId(accessToken) {
  try {
    const info = await getAntigravitySubscriptionInfo(accessToken);
    return info?.cloudaicompanionProject || null;
  } catch {
    return null;
  }
}

/**
 * Get Antigravity subscription info
 */
async function getAntigravitySubscriptionInfo(accessToken) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout
  try {
    const response = await fetch(ANTIGRAVITY_CONFIG.loadProjectApiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "User-Agent": ANTIGRAVITY_CONFIG.userAgent,
        "Content-Type": "application/json",
        "x-request-source": "local", // MITM bypass
      },
      body: JSON.stringify({ metadata: CLIENT_METADATA, mode: 1 }),
      signal: controller.signal,
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (error) {
    console.error("[Antigravity Subscription] Error:", error.message);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Claude Usage - Primary: OAuth endpoint, Fallback: legacy settings/org endpoint
 */
async function getClaudeUsage(accessToken) {
  try {
    // Primary: OAuth usage endpoint (Claude Code consumer OAuth tokens)
    const oauthResponse = await fetch(CLAUDE_CONFIG.oauthUsageUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    });

    if (oauthResponse.ok) {
      const data = await oauthResponse.json();
      const quotas = {};

      // utilization = % USED (e.g. 87 means 87% used, 13% remaining)
      const hasUtilization = (window) =>
        window && typeof window === "object" && typeof window.utilization === "number";

      const createQuotaObject = (window) => {
        const used = window.utilization;
        const remaining = Math.max(0, 100 - used);
        return {
          used,
          total: 100,
          remaining,
          remainingPercentage: remaining,
          resetAt: parseResetTime(window.resets_at),
          unlimited: false,
        };
      };

      if (hasUtilization(data.five_hour)) {
        quotas["session (5h)"] = createQuotaObject(data.five_hour);
      }

      if (hasUtilization(data.seven_day)) {
        quotas["weekly (7d)"] = createQuotaObject(data.seven_day);
      }

      // Parse model-specific weekly windows (e.g. seven_day_sonnet, seven_day_opus)
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("seven_day_") && key !== "seven_day" && hasUtilization(value)) {
          const modelName = key.replace("seven_day_", "");
          quotas[`weekly ${modelName} (7d)`] = createQuotaObject(value);
        }
      }

      return {
        plan: "Claude Code",
        extraUsage: data.extra_usage ?? null,
        quotas,
      };
    }

    // Fallback: legacy settings + org usage endpoint
    console.warn(`[Claude Usage] OAuth endpoint returned ${oauthResponse.status}, falling back to legacy`);
    return await getClaudeUsageLegacy(accessToken);
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

/**
 * Legacy Claude usage for API key / org admin users
 */
async function getClaudeUsageLegacy(accessToken) {
  try {
    const settingsResponse = await fetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    });

    if (settingsResponse.ok) {
      const settings = await settingsResponse.json();

      if (settings.organization_id) {
        const usageResponse = await fetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", settings.organization_id),
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
          }
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            quotas: usage,
          };
        }
      }

      return {
        plan: settings.plan || "Unknown",
        organization: settings.organization_name,
        message: "Claude connected. Usage details require admin access.",
      };
    }

    return { message: "Claude connected. Usage API requires admin permissions." };
  } catch (error) {
    return { message: `Claude connected. Unable to fetch usage: ${error.message}` };
  }
}

/**
 * Codex (OpenAI) Usage - Fetch from ChatGPT backend API
 */
async function getCodexUsage(accessToken) {
  try {
    const response = await fetch(CODEX_CONFIG.usageUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
    });

    if (!response.ok) {
      return { message: `Codex connected. Usage API temporarily unavailable (${response.status}).` };
    }

    const data = await response.json();

    // Parse rate limit info
    const rateLimit = data.rate_limit || {};
    const primaryWindow = rateLimit.primary_window || {};
    const secondaryWindow = rateLimit.secondary_window || {};

    // Parse reset dates (reset_at is Unix timestamp in seconds, multiply by 1000 for ms)
    const sessionResetAt = parseResetTime(primaryWindow.reset_at ? primaryWindow.reset_at * 1000 : null);
    const weeklyResetAt = parseResetTime(secondaryWindow.reset_at ? secondaryWindow.reset_at * 1000 : null);

    return {
      plan: data.plan_type || "unknown",
      limitReached: rateLimit.limit_reached || false,
      quotas: {
        session: {
          used: primaryWindow.used_percent || 0,
          total: 100,
          remaining: 100 - (primaryWindow.used_percent || 0),
          resetAt: sessionResetAt,
          unlimited: false,
        },
        weekly: {
          used: secondaryWindow.used_percent || 0,
          total: 100,
          remaining: 100 - (secondaryWindow.used_percent || 0),
          resetAt: weeklyResetAt,
          unlimited: false,
        },
      },
    };
  } catch (error) {
    throw new Error(`Failed to fetch Codex usage: ${error.message}`);
  }
}

/**
 * Kiro (AWS CodeWhisperer) Usage
 */
function parseKiroQuotaData(data) {
  const usageList = data.usageBreakdownList || [];
  const quotaInfo = {};
  const resetAt = parseResetTime(data.nextDateReset || data.resetDate);

  usageList.forEach((breakdown) => {
    const resourceType = breakdown.resourceType?.toLowerCase() || "unknown";
    const used = breakdown.currentUsageWithPrecision || 0;
    const total = breakdown.usageLimitWithPrecision || 0;

    quotaInfo[resourceType] = {
      used,
      total,
      remaining: total - used,
      resetAt,
      unlimited: false,
    };

    // Add free trial if available
    if (breakdown.freeTrialInfo) {
      const freeUsed = breakdown.freeTrialInfo.currentUsageWithPrecision || 0;
      const freeTotal = breakdown.freeTrialInfo.usageLimitWithPrecision || 0;

      quotaInfo[`${resourceType}_freetrial`] = {
        used: freeUsed,
        total: freeTotal,
        remaining: freeTotal - freeUsed,
        resetAt: parseResetTime(breakdown.freeTrialInfo.freeTrialExpiry || resetAt),
        unlimited: false,
      };
    }
  });

  return {
    plan: data.subscriptionInfo?.subscriptionTitle || "Kiro",
    quotas: quotaInfo,
  };
}

async function getKiroUsage(accessToken, providerSpecificData) {
  // Default profileArn fallback
  const DEFAULT_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
  const profileArn = providerSpecificData?.profileArn || DEFAULT_PROFILE_ARN;
  const authMethod = providerSpecificData?.authMethod || "builder-id";

  const getUsageParams = new URLSearchParams({
    isEmailRequired: "true",
    origin: "AI_EDITOR",
    resourceType: "AGENTIC_REQUEST",
  });

  // For compatibility, try multiple known Kiro usage endpoints
  const attempts = [
    {
      name: "codewhisperer-get",
      run: async () => fetch(
        `https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits?${getUsageParams.toString()}`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/json",
            "x-amz-user-agent": "aws-sdk-js/1.0.0 KiroIDE",
            "user-agent": "aws-sdk-js/1.0.0 KiroIDE",
          },
        },
      ),
    },
    {
      name: "codewhisperer-post",
      run: async () => fetch("https://codewhisperer.us-east-1.amazonaws.com", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/x-amz-json-1.0",
          "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          origin: "AI_EDITOR",
          profileArn,
          resourceType: "AGENTIC_REQUEST",
        }),
      }),
    },
    {
      name: "q-get",
      run: async () => {
        const params = new URLSearchParams({
          origin: "AI_EDITOR",
          profileArn,
          resourceType: "AGENTIC_REQUEST",
        });
        return fetch(`https://q.us-east-1.amazonaws.com/getUsageLimits?${params}`, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Accept": "application/json",
          },
        });
      },
    },
  ];

  let sawAuthError = false;
  const errors = [];

  for (const attempt of attempts) {
    try {
      const response = await attempt.run();
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (response.status === 401 || response.status === 403) {
          sawAuthError = true;
        }
        errors.push(`${attempt.name}:${response.status}${errorText ? `:${errorText}` : ""}`);
        continue;
      }

      const data = await response.json();
      return parseKiroQuotaData(data);
    } catch (error) {
      errors.push(`${attempt.name}:${error.message}`);
    }
  }

  if (sawAuthError && authMethod === "idc") {
    return {
      message: "Kiro quota API is unavailable for the current AWS IAM Identity Center session. Chat may still work. If this persists after renewing your session, reconnect Kiro.",
      quotas: {},
    };
  }

  // Social auth (Google/GitHub) - these use a different token format that may not work with AWS CodeWhisperer quota APIs
  if (sawAuthError && (authMethod === "google" || authMethod === "github")) {
    return {
      message: "Kiro quota API authentication expired. Chat may still work.",
      quotas: {},
    };
  }

  if (sawAuthError) {
    return {
      message: "Kiro quota API rejected the current token. Chat may still work.",
      quotas: {},
    };
  }

  const fallbackMessage =
    errors.length > 0
      ? `Unable to fetch Kiro usage right now. (${errors[errors.length - 1]})`
      : "Unable to fetch Kiro usage right now.";

  return {
    message: fallbackMessage,
    quotas: {},
  };
}

/**
 * Qwen Usage
 */
async function getQwenUsage(accessToken, providerSpecificData) {
  try {
    const resourceUrl = providerSpecificData?.resourceUrl;
    if (!resourceUrl) {
      return { message: "Qwen connected. No resource URL available." };
    }

    // Qwen may have usage endpoint at resource URL
    return { message: "Qwen connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch Qwen usage." };
  }
}

/**
 * iFlow Usage
 */
async function getIflowUsage(accessToken) {
  try {
    // iFlow may have usage endpoint
    return { message: "iFlow connected. Usage tracked per request." };
  } catch (error) {
    return { message: "Unable to fetch iFlow usage." };
  }
}

/**
 * Grok CLI / Grok Build billing + subscription
 * Official CLI: GET /v1/billing?format=credits + GET /v1/user?include=subscription
 * Values often arrive as protobuf-json `{ val: number }`.
 */
function unwrapGrokBillingVal(value, fallback = 0) {
  if (value == null) return fallback;
  if (typeof value === "object" && !Array.isArray(value) && "val" in value) {
    const n = Number(value.val);
    return Number.isFinite(n) ? n : fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function buildGrokCliUsageHeaders(accessToken, providerSpecificData = {}) {
  const psd = providerSpecificData || {};
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": GROK_CLI_USER_AGENT,
    "x-xai-token-auth": GROK_CLI_TOKEN_AUTH,
    "x-grok-client-identifier": GROK_CLI_CLIENT_IDENTIFIER,
    "x-grok-client-version": GROK_CLI_CLIENT_VERSION,
  };
  if (psd.email) headers["x-email"] = psd.email;
  if (psd.userId || psd.principalId) {
    headers["x-userid"] = psd.userId || psd.principalId;
  }
  return headers;
}

function grokQuotaRow({ used, total, resetAt }) {
  const safeTotal = Math.max(0, Number(total) || 0);
  const safeUsed = Math.max(0, Number(used) || 0);
  if (safeTotal <= 0) {
    return {
      used: safeUsed,
      total: 0,
      remainingPercentage: 0,
      resetAt: resetAt || null,
      unlimited: false,
    };
  }
  const remaining = Math.max(0, safeTotal - safeUsed);
  return {
    used: safeUsed,
    total: safeTotal,
    remainingPercentage: (remaining / safeTotal) * 100,
    resetAt: resetAt || null,
    unlimited: false,
  };
}

function grokPeriodLabel(config, root) {
  const periodType =
    config?.currentPeriod?.type ||
    root?.currentPeriod?.type ||
    config?.periodType ||
    "";
  if (/WEEKLY/i.test(String(periodType))) return "Weekly";
  if (/MONTHLY|MONTH/i.test(String(periodType))) return "Monthly";
  if (/DAILY|DAY/i.test(String(periodType))) return "Daily";
  // Default label for SuperGrok-style shared pool (docs: weekly allowance)
  return "Weekly";
}

/**
 * Map Grok CLI billing JSON → quota rows.
 *
 * Two different billing shapes (must merge both endpoints):
 *
 * 1) GET /v1/billing?format=credits  ← Settings → Usage "Weekly limit: 73%"
 *    - creditUsagePercent (USED % of weekly SuperGrok pool)
 *    - productUsage[].usagePercent (e.g. GrokBuild)
 *    - currentPeriod weekly start/end (reset date)
 *
 * 2) GET /v1/billing  ← dollar credit ledger (monthly calendar)
 *    - used / monthlyLimit (cents) — NOT the same as Settings weekly %
 *
 * On-demand is EXTRA pay-as-you-go only when onDemandCap > 0.
 */
export function parseGrokCliBilling(billing, user = null) {
  const root = billing && typeof billing === "object" ? billing : {};
  const config =
    root.config && typeof root.config === "object" && !Array.isArray(root.config)
      ? root.config
      : root;

  // Prefer weekly period end from format=credits (matches Settings reset)
  const periodEnd =
    parseResetTime(config.currentPeriod?.end) ||
    parseResetTime(config.billingPeriodEnd) ||
    parseResetTime(root.billingPeriodEnd) ||
    null;

  const quotas = {};
  const periodLabel = grokPeriodLabel(config, root);

  // --- Primary: Settings weekly pool (USED %) ---
  // productUsage GrokBuild is what the CLI consumes; fall back to overall creditUsagePercent
  let usedPercent = NaN;
  if (Array.isArray(config.productUsage)) {
    const build = config.productUsage.find(
      (p) =>
        p &&
        typeof p === "object" &&
        /grokbuild|build/i.test(String(p.product || "")),
    );
    if (build && build.usagePercent != null) {
      usedPercent = unwrapGrokBillingVal(build.usagePercent, NaN);
    }
  }
  if (!Number.isFinite(usedPercent)) {
    usedPercent = unwrapGrokBillingVal(
      config.creditUsagePercent ?? root.creditUsagePercent,
      NaN,
    );
  }
  if (Number.isFinite(usedPercent)) {
    const clamped = Math.min(100, Math.max(0, usedPercent));
    const remaining = Math.max(0, 100 - clamped);
    // used/total as percent points so the bar subtitle reads "74 / 100 used"
    quotas[periodLabel] = {
      used: clamped,
      total: 100,
      remainingPercentage: remaining,
      // Settings UI shows USED % ("Weekly limit: 73%") — surface that as the hero number
      usedPercentage: clamped,
      displayAsUsed: true,
      unit: "percent",
      resetAt: periodEnd,
      unlimited: false,
    };
  }

  // --- Secondary: dollar credit ledger from plain /v1/billing (cents → dollars) ---
  const poolUsed = unwrapGrokBillingVal(
    config.used ?? root.used ?? config.usageUsed ?? root.usageUsed,
    NaN,
  );
  const poolLimit = unwrapGrokBillingVal(
    config.monthlyLimit ??
      root.monthlyLimit ??
      config.weeklyLimit ??
      root.weeklyLimit ??
      config.limit ??
      root.limit,
    NaN,
  );
  if (Number.isFinite(poolLimit) && poolLimit > 0 && !quotas[periodLabel]) {
    // Only use dollar ratio as primary when creditUsagePercent is missing
    const used = Number.isFinite(poolUsed) ? Math.max(0, poolUsed) : 0;
    quotas[periodLabel] = {
      ...grokQuotaRow({ used, total: poolLimit, resetAt: periodEnd }),
      unit: "credits",
    };
  } else if (Number.isFinite(poolLimit) && poolLimit > 0) {
    // Show as extra row so operators still see $ balance vs weekly %
    const used = Number.isFinite(poolUsed) ? Math.max(0, poolUsed) : 0;
    const dollarsUsed = used / 100;
    const dollarsTotal = poolLimit / 100;
    quotas["Credits ($)"] = {
      ...grokQuotaRow({
        used: dollarsUsed,
        total: dollarsTotal,
        resetAt:
          parseResetTime(config.billingPeriodEnd) ||
          parseResetTime(root.billingPeriodEnd) ||
          periodEnd,
      }),
      unit: "dollars",
    };
  }

  // On-demand spending cap (extra pay-as-you-go)
  const onDemandCap = unwrapGrokBillingVal(
    config.onDemandCap ?? root.onDemandCap,
    NaN,
  );
  const onDemandUsed = unwrapGrokBillingVal(
    config.onDemandUsed ?? root.onDemandUsed,
    NaN,
  );
  if (Number.isFinite(onDemandCap) && onDemandCap > 0) {
    const used = Number.isFinite(onDemandUsed) ? Math.max(0, onDemandUsed) : 0;
    quotas["On-demand"] = {
      ...grokQuotaRow({
        used: used / 100,
        total: onDemandCap / 100,
        resetAt: periodEnd,
      }),
      unit: "dollars",
    };
  }

  const prepaid = unwrapGrokBillingVal(
    config.prepaidBalance ?? root.prepaidBalance,
    NaN,
  );
  if (Number.isFinite(prepaid) && prepaid > 0) {
    quotas.Prepaid = {
      used: 0,
      total: prepaid / 100,
      remainingPercentage: 100,
      resetAt: null,
      unlimited: false,
      unit: "dollars",
    };
  }

  // True free/promo exhaustion: nothing parseable
  if (Object.keys(quotas).length === 0) {
    const capZero =
      Number.isFinite(onDemandCap) &&
      onDemandCap === 0 &&
      Number.isFinite(onDemandUsed);
    if (capZero) {
      quotas["On-demand"] = {
        used: 1,
        total: 1,
        remainingPercentage: 0,
        usedPercentage: 100,
        displayAsUsed: true,
        resetAt: periodEnd,
        unlimited: false,
      };
    }
  }

  // settings: subscription_tier_display; user API: subscriptionTier (e.g. GrokPro)
  const tierRaw =
    (typeof user?.subscription_tier_display === "string" &&
      user.subscription_tier_display) ||
    (typeof user?.subscriptionTier === "string" && user.subscriptionTier) ||
    (typeof user?.subscriptionTier === "string" && user.subscriptionTier) ||
    "";
  const plan = tierRaw
    ? String(tierRaw)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
    : user?.hasGrokCodeAccess
      ? "Grok Code"
      : "Grok Build";

  return { plan, quotas, periodEnd };
}

/**
 * Merge Grok billing payloads.
 * Order: format=credits first (weekly %), then plain /v1/billing (dollar ledger).
 * Never overwrite weekly % fields once set.
 */
function mergeGrokBillingPayloads(...payloads) {
  const weeklyKeys = new Set([
    "creditUsagePercent",
    "productUsage",
    "currentPeriod",
    "isUnifiedBillingUser",
  ]);
  const merged = { config: {} };
  for (const p of payloads) {
    if (!p || typeof p !== "object") continue;
    for (const [k, v] of Object.entries(p)) {
      if (k === "config" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [ck, cv] of Object.entries(v)) {
          if (weeklyKeys.has(ck) && merged.config[ck] !== undefined) continue;
          // Dollar ledger: last write wins (plain billing usually has used/monthlyLimit)
          if (ck === "used" || ck === "monthlyLimit") {
            merged.config[ck] = cv;
            continue;
          }
          if (merged.config[ck] === undefined) merged.config[ck] = cv;
          else if (!weeklyKeys.has(ck)) merged.config[ck] = cv;
        }
      } else if (merged[k] === undefined) {
        merged[k] = v;
      }
    }
  }
  if (Object.keys(merged.config).length === 0) delete merged.config;
  return merged;
}

async function getGrokCliUsage(accessToken, providerSpecificData = {}) {
  if (!accessToken) {
    return { message: "Grok CLI access token not available." };
  }

  const headers = buildGrokCliUsageHeaders(accessToken, providerSpecificData);

  try {
    // Critical: plain /v1/billing has config.used + config.monthlyLimit (weekly %).
    // format=credits often omits those and only returns onDemandCap=0 → false 0% bar.
    const [billingRes, creditsRes, userRes, settingsRes] = await Promise.all([
      fetch("https://cli-chat-proxy.grok.com/v1/billing", {
        method: "GET",
        headers,
      }),
      fetch("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
        method: "GET",
        headers,
      }).catch(() => null),
      fetch("https://cli-chat-proxy.grok.com/v1/user?include=subscription", {
        method: "GET",
        headers,
      }).catch(() => null),
      fetch("https://cli-chat-proxy.grok.com/v1/settings", {
        method: "GET",
        headers,
      }).catch(() => null),
    ]);

    if (billingRes.status === 401 || billingRes.status === 403) {
      return {
        message: "Grok CLI authentication expired. Please re-authorize.",
      };
    }
    // Fall back to credits-only if plain billing fails
    const primaryRes =
      billingRes.ok || !creditsRes?.ok ? billingRes : creditsRes;
    if (!primaryRes.ok) {
      const errText = await primaryRes.text().catch(() => "");
      const trimmed = errText ? `: ${errText.slice(0, 200)}` : "";
      return {
        message: `Grok CLI billing API error (${primaryRes.status})${trimmed}`,
      };
    }

    const billingPlain = billingRes.ok
      ? await billingRes.json().catch(() => null)
      : null;
    const billingCredits = creditsRes?.ok
      ? await creditsRes.json().catch(() => null)
      : null;

    // credits first (weekly %), then plain (dollar used/monthlyLimit)
    const billing = mergeGrokBillingPayloads(billingCredits, billingPlain);
    if (!billing || typeof billing !== "object" || Object.keys(billing).length === 0) {
      return { message: "Grok CLI billing response was not JSON." };
    }

    let user = null;
    if (userRes?.ok) {
      user = await userRes.json().catch(() => null);
    }
    if (settingsRes?.ok) {
      const settings = await settingsRes.json().catch(() => null);
      if (settings && typeof settings === "object") {
        if (!user) user = {};
        if (settings.subscription_tier_display) {
          user.subscription_tier_display = settings.subscription_tier_display;
        }
        if (settings.subscriptionTier && !user.subscriptionTier) {
          user.subscriptionTier = settings.subscriptionTier;
        }
      }
    }

    const parsed = parseGrokCliBilling(billing, user);

    // Dashboard hides QuotaTable when `message` is set — only set when no rows.
    if (!parsed.quotas || Object.keys(parsed.quotas).length === 0) {
      const cfg = billing.config || billing;
      const keys = Object.keys(cfg || {}).slice(0, 24).join(",");
      console.warn(
        `[Grok usage] no quota rows parsed; billing config keys: ${keys || "(none)"}`,
      );
      return {
        plan: parsed.plan,
        message:
          "Grok Build connected, but no credit allotment was returned. Free promo may be exhausted — upgrade at https://grok.com/supergrok or add credits at https://grok.com/?_s=usage.",
        quotas: {},
      };
    }

    return {
      plan: parsed.plan,
      quotas: parsed.quotas,
      resetDate: parsed.periodEnd,
    };
  } catch (error) {
    return {
      message: `Unable to fetch Grok CLI usage: ${error?.message || error}`,
    };
  }
}
