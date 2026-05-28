const BASE64_BLOCK_SIZE = 4;

function decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const missingPadding =
      (BASE64_BLOCK_SIZE - (base64.length % BASE64_BLOCK_SIZE)) %
      BASE64_BLOCK_SIZE;
    const padded = base64 + "=".repeat(missingPadding);
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getOpenAiAuthClaims(payload) {
  return payload?.["https://api.openai.com/auth"] || {};
}

function getOpenAiProfileClaims(payload) {
  return payload?.["https://api.openai.com/profile"] || {};
}

function requireString(value, message) {
  if (!value || typeof value !== "string") {
    throw new Error(message);
  }

  return value.trim();
}

function getExpiresAt(accessTokenPayload) {
  if (!Number.isFinite(accessTokenPayload?.exp)) return null;
  return new Date(accessTokenPayload.exp * 1000).toISOString();
}

export function parseCodexAuthJson(authJsonContent) {
  let authJson;
  try {
    authJson = JSON.parse(authJsonContent);
  } catch {
    throw new Error("Invalid JSON");
  }

  const tokens = authJson?.tokens;
  if (!tokens || typeof tokens !== "object") {
    throw new Error("Codex auth.json is missing tokens");
  }

  const accessToken = requireString(
    tokens.access_token,
    "Codex auth.json is missing tokens.access_token",
  );
  const refreshToken = requireString(
    tokens.refresh_token,
    "Codex auth.json is missing tokens.refresh_token",
  );
  const idToken =
    typeof tokens.id_token === "string" && tokens.id_token.trim()
      ? tokens.id_token.trim()
      : null;

  const accessTokenPayload = decodeJwtPayload(accessToken);
  const idTokenPayload = decodeJwtPayload(idToken);
  const authClaims = getOpenAiAuthClaims(accessTokenPayload);
  const profileClaims = getOpenAiProfileClaims(accessTokenPayload);
  const email =
    profileClaims.email ||
    accessTokenPayload?.email ||
    idTokenPayload?.email ||
    accessTokenPayload?.preferred_username ||
    accessTokenPayload?.sub ||
    null;
  const accountId =
    authClaims.chatgpt_account_id ||
    tokens.account_id ||
    authClaims.chatgpt_account_user_id ||
    null;

  return {
    provider: "codex",
    authType: "oauth",
    accessToken,
    refreshToken,
    idToken,
    email,
    expiresAt: getExpiresAt(accessTokenPayload),
    providerSpecificData: {
      accountId,
      authMethod: "auth-json-import",
      authMode: authJson.auth_mode || null,
      planType: authClaims.chatgpt_plan_type || null,
      lastRefresh: authJson.last_refresh || null,
    },
  };
}
