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

function getExpiresAt(accessTokenPayload, rawExpiresIn) {
  if (Number.isFinite(accessTokenPayload?.exp)) {
    return new Date(accessTokenPayload.exp * 1000).toISOString();
  }
  if (Number.isFinite(rawExpiresIn) && rawExpiresIn > 0) {
    return new Date(Date.now() + rawExpiresIn * 1000).toISOString();
  }
  return null;
}

/**
 * Parses a single account object, whether from standard auth.json or account order export.
 *
 * Supported shapes:
 * 1. Standard auth.json:
 *    { auth_mode: "chatgpt", tokens: { access_token, refresh_token, id_token, ... } }
 * 2. Order/Batch export object:
 *    { access_token, refresh_token, id_token, chatgpt_account_id, email, oai_did, phone, ... }
 * 3. Wrapped or flat variations.
 */
export function parseCodexAccountItem(item) {
  if (!item || typeof item !== "object") {
    throw new Error("Invalid account data: expected an object");
  }

  // Detect token container: either item.tokens or item itself
  const tokens = item.tokens && typeof item.tokens === "object" ? item.tokens : item;

  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token.trim() : null;
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : null;

  if (!accessToken) {
    throw new Error("Missing access_token");
  }
  if (!refreshToken) {
    throw new Error("Missing refresh_token");
  }

  const idToken =
    typeof tokens.id_token === "string" && tokens.id_token.trim()
      ? tokens.id_token.trim()
      : null;

  const accessTokenPayload = decodeJwtPayload(accessToken);
  const idTokenPayload = decodeJwtPayload(idToken);
  const authClaims = getOpenAiAuthClaims(accessTokenPayload);
  const profileClaims = getOpenAiProfileClaims(accessTokenPayload);

  const email =
    item.email?.trim() ||
    profileClaims.email ||
    accessTokenPayload?.email ||
    idTokenPayload?.email ||
    accessTokenPayload?.preferred_username ||
    accessTokenPayload?.sub ||
    null;

  const accountId =
    authClaims.chatgpt_account_id ||
    item.chatgpt_account_id?.trim() ||
    tokens.account_id ||
    authClaims.chatgpt_account_user_id ||
    null;

  const oaiDid = item.oai_did?.trim() || tokens.oai_did?.trim() || null;
  const phone = item.phone?.trim() || null;
  const impersonate = item.impersonate?.trim() || null;
  const planType = authClaims.chatgpt_plan_type || (item.plus_1m_free ? "plus" : null);

  const providerSpecificData = {
    accountId,
    authMethod: "auth-json-import",
    authMode: item.auth_mode || "chatgpt",
    planType: planType || null,
    lastRefresh: item.last_refresh || null,
  };

  if (oaiDid) providerSpecificData.oaiDid = oaiDid;
  if (phone) providerSpecificData.phone = phone;
  if (impersonate) providerSpecificData.impersonate = impersonate;
  if (item.chatgpt_account_id) providerSpecificData.chatgptAccountId = item.chatgpt_account_id;

  return {
    provider: "codex",
    authType: "oauth",
    accessToken,
    refreshToken,
    idToken,
    email,
    expiresAt: getExpiresAt(accessTokenPayload, item.expires_in || tokens.expires_in),
    providerSpecificData,
  };
}

/**
 * Parses single auth.json content (backward-compatible function).
 */
export function parseCodexAuthJson(authJsonContent) {
  let authJson;
  try {
    authJson = typeof authJsonContent === "string" ? JSON.parse(authJsonContent) : authJsonContent;
  } catch {
    throw new Error("Invalid JSON");
  }

  const tokens = authJson?.tokens;
  if (!tokens || typeof tokens !== "object") {
    throw new Error("Codex auth.json is missing tokens");
  }

  if (!tokens.access_token || typeof tokens.access_token !== "string") {
    throw new Error("Codex auth.json is missing tokens.access_token");
  }
  if (!tokens.refresh_token || typeof tokens.refresh_token !== "string") {
    throw new Error("Codex auth.json is missing tokens.refresh_token");
  }

  return parseCodexAccountItem(authJson);
}

/**
 * Parses batch input from string, array, or object.
 * Returns { accounts: [...], errors: [...] }
 */
export function parseCodexBatch(rawInput) {
  if (!rawInput) {
    return { accounts: [], errors: ["Input is empty"] };
  }

  let parsed;
  if (typeof rawInput === "string") {
    const trimmed = rawInput.trim();
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Check if it's multiple JSON objects separated by newlines (NDJSON / JSON lines)
      const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const accounts = [];
      const errors = [];

      for (let i = 0; i < lines.length; i++) {
        try {
          const lineObj = JSON.parse(lines[i]);
          accounts.push(parseCodexAccountItem(lineObj));
        } catch (err) {
          errors.push(`Line ${i + 1}: ${err.message}`);
        }
      }

      if (accounts.length > 0) {
        return { accounts, errors };
      }

      return { accounts: [], errors: ["Invalid JSON format"] };
    }
  } else {
    parsed = rawInput;
  }

  // If parsed is an array
  let itemsToParse = [];
  if (Array.isArray(parsed)) {
    itemsToParse = parsed;
  } else if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.accounts)) {
      itemsToParse = parsed.accounts;
    } else if (Array.isArray(parsed.items)) {
      itemsToParse = parsed.items;
    } else if (Array.isArray(parsed.data)) {
      itemsToParse = parsed.data;
    } else {
      // Single object
      itemsToParse = [parsed];
    }
  } else {
    return { accounts: [], errors: ["Expected JSON object or array"] };
  }

  const accounts = [];
  const errors = [];

  for (let idx = 0; idx < itemsToParse.length; idx++) {
    try {
      const parsedItem = parseCodexAccountItem(itemsToParse[idx]);
      accounts.push(parsedItem);
    } catch (err) {
      errors.push(`Item ${idx + 1}: ${err.message}`);
    }
  }

  return { accounts, errors };
}
