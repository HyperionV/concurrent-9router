import { v4 as uuidv4 } from "uuid";
import { getSqlite } from "@/lib/sqlite/runtime.js";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  withSettingsAliases,
} from "@/lib/sqlite/defaults.js";
import {
  asBool,
  fromBool,
  nowIso,
  parseJson,
  stringifyJson,
} from "@/lib/sqlite/helpers.js";

function db() {
  return getSqlite();
}

function mapSettingsRow(row) {
  if (!row) {
    return withSettingsAliases(normalizeSettings(DEFAULT_SETTINGS));
  }

  return withSettingsAliases(
    normalizeSettings({
      cloudEnabled: fromBool(row.cloud_enabled),
      cloudUrl: row.cloud_url || "",
      tunnelEnabled: fromBool(row.tunnel_enabled),
      tunnelUrl: row.tunnel_url || "",
      tunnelProvider: row.tunnel_provider || "cloudflare",
      tailscaleEnabled: fromBool(row.tailscale_enabled),
      tailscaleUrl: row.tailscale_url || "",
      fallbackStrategy: row.fallback_strategy || "fill-first",
      stickyRoundRobinLimit: row.sticky_round_robin_limit ?? 3,
      providerStrategies: parseJson(row.provider_strategies_json, {}),
      comboStrategy: row.combo_strategy || "fallback",
      comboStrategies: parseJson(row.combo_strategies_json, {}),
      requireLogin: fromBool(row.require_login),
      tunnelDashboardAccess: fromBool(row.tunnel_dashboard_access),
      mitmEnabled: fromBool(row.mitm_enabled),
      observabilityEnabled: fromBool(row.observability_enabled),
      observabilityMaxRecords: row.observability_max_records ?? 1000,
      observabilityBatchSize: row.observability_batch_size ?? 20,
      observabilityFlushIntervalMs: row.observability_flush_interval_ms ?? 5000,
      observabilityMaxJsonSize: row.observability_max_json_size ?? 1024,
      outboundProxyEnabled: fromBool(row.outbound_proxy_enabled),
      outboundProxyUrl: row.outbound_proxy_url || "",
      outboundNoProxy: row.outbound_no_proxy || "",
      mitmRouterBaseUrl:
        row.mitm_router_base_url || DEFAULT_SETTINGS.mitmRouterBaseUrl,
      password: row.password || undefined,
    }),
  );
}

function getSettingsRow() {
  return db().prepare("SELECT * FROM app_settings WHERE id = 1").get();
}

export function readSettings() {
  return mapSettingsRow(getSettingsRow());
}

export function writeSettings(updates) {
  const current = readSettings();
  const next = normalizeSettings({
    ...current,
    ...updates,
    observabilityEnabled:
      typeof updates.enableObservability === "boolean"
        ? updates.enableObservability
        : (updates.observabilityEnabled ?? current.observabilityEnabled),
  });

  db()
    .prepare(
      `
    UPDATE app_settings
    SET
      cloud_enabled = @cloudEnabled,
      cloud_url = @cloudUrl,
      tunnel_enabled = @tunnelEnabled,
      tunnel_url = @tunnelUrl,
      tunnel_provider = @tunnelProvider,
      tailscale_enabled = @tailscaleEnabled,
      tailscale_url = @tailscaleUrl,
      fallback_strategy = @fallbackStrategy,
      sticky_round_robin_limit = @stickyRoundRobinLimit,
      provider_strategies_json = @providerStrategiesJson,
      combo_strategy = @comboStrategy,
      combo_strategies_json = @comboStrategiesJson,
      require_login = @requireLogin,
      tunnel_dashboard_access = @tunnelDashboardAccess,
      observability_enabled = @observabilityEnabled,
      observability_max_records = @observabilityMaxRecords,
      observability_batch_size = @observabilityBatchSize,
      observability_flush_interval_ms = @observabilityFlushIntervalMs,
      observability_max_json_size = @observabilityMaxJsonSize,
      outbound_proxy_enabled = @outboundProxyEnabled,
      outbound_proxy_url = @outboundProxyUrl,
      outbound_no_proxy = @outboundNoProxy,
      mitm_router_base_url = @mitmRouterBaseUrl,
      password = @password,
      mitm_enabled = @mitmEnabled
    WHERE id = 1
  `,
    )
    .run({
      cloudEnabled: asBool(next.cloudEnabled),
      cloudUrl: next.cloudUrl || "",
      tunnelEnabled: asBool(next.tunnelEnabled),
      tunnelUrl: next.tunnelUrl || "",
      tunnelProvider: next.tunnelProvider || "cloudflare",
      tailscaleEnabled: asBool(next.tailscaleEnabled),
      tailscaleUrl: next.tailscaleUrl || "",
      fallbackStrategy: next.fallbackStrategy || "fill-first",
      stickyRoundRobinLimit: next.stickyRoundRobinLimit ?? 3,
      providerStrategiesJson: stringifyJson(next.providerStrategies, {}),
      comboStrategy: next.comboStrategy || "fallback",
      comboStrategiesJson: stringifyJson(next.comboStrategies, {}),
      requireLogin: asBool(next.requireLogin),
      tunnelDashboardAccess: asBool(next.tunnelDashboardAccess),
      observabilityEnabled: asBool(next.observabilityEnabled),
      observabilityMaxRecords: next.observabilityMaxRecords ?? 1000,
      observabilityBatchSize: next.observabilityBatchSize ?? 20,
      observabilityFlushIntervalMs: next.observabilityFlushIntervalMs ?? 5000,
      observabilityMaxJsonSize: next.observabilityMaxJsonSize ?? 1024,
      outboundProxyEnabled: asBool(next.outboundProxyEnabled),
      outboundProxyUrl: next.outboundProxyUrl || "",
      outboundNoProxy: next.outboundNoProxy || "",
      mitmRouterBaseUrl:
        next.mitmRouterBaseUrl || DEFAULT_SETTINGS.mitmRouterBaseUrl,
      password: next.password || null,
      mitmEnabled: asBool(next.mitmEnabled),
    });

  return readSettings();
}

function mapNodeRow(row) {
  return row
    ? {
        id: row.id,
        type: row.type,
        name: row.name,
        prefix: row.prefix,
        apiType: row.api_type,
        baseUrl: row.base_url,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

export function listProviderNodes(filter = {}) {
  const rows = db()
    .prepare("SELECT * FROM provider_nodes ORDER BY updated_at DESC")
    .all();
  let nodes = rows.map(mapNodeRow);
  if (filter.type) nodes = nodes.filter((node) => node.type === filter.type);
  return nodes;
}

export function getProviderNode(id) {
  return mapNodeRow(
    db().prepare("SELECT * FROM provider_nodes WHERE id = ?").get(id),
  );
}

export function createProviderNodeRecord(data) {
  const now = nowIso();
  const node = {
    id: data.id || uuidv4(),
    type: data.type,
    name: data.name,
    prefix: data.prefix,
    apiType: data.apiType,
    baseUrl: data.baseUrl,
    createdAt: now,
    updatedAt: now,
  };
  db()
    .prepare(
      `
    INSERT INTO provider_nodes (id, type, name, prefix, api_type, base_url, created_at, updated_at)
    VALUES (@id, @type, @name, @prefix, @apiType, @baseUrl, @createdAt, @updatedAt)
  `,
    )
    .run(node);
  return node;
}

export function updateProviderNodeRecord(id, data) {
  const existing = getProviderNode(id);
  if (!existing) return null;
  const next = {
    ...existing,
    ...data,
    updatedAt: nowIso(),
  };
  db()
    .prepare(
      `
    UPDATE provider_nodes
    SET type = @type, name = @name, prefix = @prefix, api_type = @apiType, base_url = @baseUrl, updated_at = @updatedAt
    WHERE id = @id
  `,
    )
    .run(next);
  return getProviderNode(id);
}

export function deleteProviderNodeRecord(id) {
  const existing = getProviderNode(id);
  if (!existing) return null;
  db().prepare("DELETE FROM provider_nodes WHERE id = ?").run(id);
  return existing;
}

function mapProxyPoolRow(row) {
  return row
    ? {
        id: row.id,
        name: row.name,
        proxyUrl: row.proxy_url,
        noProxy: row.no_proxy,
        type: row.type,
        isActive: fromBool(row.is_active),
        strictProxy: fromBool(row.strict_proxy),
        testStatus: row.test_status,
        lastTestedAt: row.last_tested_at,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    : null;
}

export function listProxyPools(filter = {}) {
  let pools = db()
    .prepare("SELECT * FROM proxy_pools ORDER BY updated_at DESC")
    .all()
    .map(mapProxyPoolRow);
  if (filter.isActive !== undefined)
    pools = pools.filter((pool) => pool.isActive === filter.isActive);
  if (filter.testStatus)
    pools = pools.filter((pool) => pool.testStatus === filter.testStatus);
  return pools;
}

export function getProxyPool(id) {
  return mapProxyPoolRow(
    db().prepare("SELECT * FROM proxy_pools WHERE id = ?").get(id),
  );
}

export function createProxyPoolRecord(data) {
  const now = nowIso();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    createdAt: now,
    updatedAt: now,
  };
  db()
    .prepare(
      `
    INSERT INTO proxy_pools (
      id, name, proxy_url, no_proxy, type, is_active, strict_proxy,
      test_status, last_tested_at, last_error, created_at, updated_at
    ) VALUES (
      @id, @name, @proxyUrl, @noProxy, @type, @isActive, @strictProxy,
      @testStatus, @lastTestedAt, @lastError, @createdAt, @updatedAt
    )
  `,
    )
    .run({
      ...pool,
      isActive: asBool(pool.isActive),
      strictProxy: asBool(pool.strictProxy),
    });
  return pool;
}

export function updateProxyPoolRecord(id, data) {
  const existing = getProxyPool(id);
  if (!existing) return null;
  const next = { ...existing, ...data, updatedAt: nowIso() };
  db()
    .prepare(
      `
    UPDATE proxy_pools
    SET
      name = @name,
      proxy_url = @proxyUrl,
      no_proxy = @noProxy,
      type = @type,
      is_active = @isActive,
      strict_proxy = @strictProxy,
      test_status = @testStatus,
      last_tested_at = @lastTestedAt,
      last_error = @lastError,
      updated_at = @updatedAt
    WHERE id = @id
  `,
    )
    .run({
      ...next,
      isActive: asBool(next.isActive),
      strictProxy: asBool(next.strictProxy),
    });
  return getProxyPool(id);
}

export function deleteProxyPoolRecord(id) {
  const existing = getProxyPool(id);
  if (!existing) return null;
  db().prepare("DELETE FROM proxy_pools WHERE id = ?").run(id);
  return existing;
}

const RESERVED_CONNECTION_FIELDS = new Set([
  "id",
  "provider",
  "authType",
  "name",
  "priority",
  "isActive",
  "createdAt",
  "updatedAt",
  "displayName",
  "email",
  "globalPriority",
  "defaultModel",
  "accessToken",
  "refreshToken",
  "expiresAt",
  "tokenType",
  "scope",
  "idToken",
  "projectId",
  "apiKey",
  "testStatus",
  "lastTested",
  "lastError",
  "lastErrorAt",
  "rateLimitedUntil",
  "expiresIn",
  "errorCode",
  "consecutiveUseCount",
  "providerSpecificData",
]);

function readConnectionCooldowns(connectionId) {
  const rows = db()
    .prepare(
      `
    SELECT model_id AS modelId, locked_until AS lockedUntil
    FROM connection_model_cooldowns
    WHERE connection_id = ?
  `,
    )
    .all(connectionId);
  return Object.fromEntries(
    rows.map((row) => [`modelLock_${row.modelId}`, row.lockedUntil]),
  );
}

function mapConnectionRow(row) {
  if (!row) return null;
  const extra = parseJson(row.extra_fields_json, {});
  return {
    id: row.id,
    provider: row.provider,
    authType: row.auth_type,
    name: row.name,
    priority: row.priority,
    isActive: fromBool(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.display_name != null ? { displayName: row.display_name } : {}),
    ...(row.email != null ? { email: row.email } : {}),
    ...(row.global_priority != null
      ? { globalPriority: row.global_priority }
      : {}),
    ...(row.default_model != null ? { defaultModel: row.default_model } : {}),
    ...(row.access_token != null ? { accessToken: row.access_token } : {}),
    ...(row.refresh_token != null ? { refreshToken: row.refresh_token } : {}),
    ...(row.expires_at != null ? { expiresAt: row.expires_at } : {}),
    ...(row.token_type != null ? { tokenType: row.token_type } : {}),
    ...(row.scope != null ? { scope: row.scope } : {}),
    ...(row.id_token != null ? { idToken: row.id_token } : {}),
    ...(row.project_id != null ? { projectId: row.project_id } : {}),
    ...(row.api_key != null ? { apiKey: row.api_key } : {}),
    ...(row.test_status != null ? { testStatus: row.test_status } : {}),
    ...(row.last_tested != null ? { lastTested: row.last_tested } : {}),
    ...(row.last_error != null ? { lastError: row.last_error } : {}),
    ...(row.last_error_at != null ? { lastErrorAt: row.last_error_at } : {}),
    ...(row.rate_limited_until != null
      ? { rateLimitedUntil: row.rate_limited_until }
      : {}),
    ...(row.expires_in != null ? { expiresIn: row.expires_in } : {}),
    ...(row.error_code != null ? { errorCode: row.error_code } : {}),
    ...(row.consecutive_use_count != null
      ? { consecutiveUseCount: row.consecutive_use_count }
      : {}),
    providerSpecificData: parseJson(row.provider_specific_data_json, {}),
    ...extra,
    ...readConnectionCooldowns(row.id),
  };
}

function splitConnectionData(data) {
  const columnData = {};
  const extra = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (key.startsWith("modelLock_")) {
      continue;
    }
    if (RESERVED_CONNECTION_FIELDS.has(key)) {
      columnData[key] = value;
    } else {
      extra[key] = value;
    }
  }
  return { columnData, extra };
}

function writeConnectionCooldowns(connectionId, data) {
  const modelLocks = Object.entries(data || {}).filter(([key]) =>
    key.startsWith("modelLock_"),
  );
  for (const [key, value] of modelLocks) {
    const modelId = key.slice("modelLock_".length);
    if (value == null || value === "") {
      db()
        .prepare(
          "DELETE FROM connection_model_cooldowns WHERE connection_id = ? AND model_id = ?",
        )
        .run(connectionId, modelId);
    } else {
      db()
        .prepare(
          `
        INSERT INTO connection_model_cooldowns (connection_id, model_id, locked_until)
        VALUES (?, ?, ?)
        ON CONFLICT(connection_id, model_id) DO UPDATE SET locked_until = excluded.locked_until
      `,
        )
        .run(connectionId, modelId, value);
    }
  }
}

export function listProviderConnections(filter = {}) {
  const rows = db()
    .prepare(
      "SELECT * FROM provider_connections ORDER BY priority ASC, updated_at DESC",
    )
    .all();
  let connections = rows.map(mapConnectionRow);
  if (filter.provider)
    connections = connections.filter((row) => row.provider === filter.provider);
  if (filter.isActive !== undefined)
    connections = connections.filter((row) => row.isActive === filter.isActive);
  return connections;
}

export function getProviderConnection(id) {
  return mapConnectionRow(
    db().prepare("SELECT * FROM provider_connections WHERE id = ?").get(id),
  );
}

function nextConnectionPriority(provider, requestedPriority) {
  if (requestedPriority) return requestedPriority;
  const row = db()
    .prepare(
      "SELECT MAX(priority) AS maxPriority FROM provider_connections WHERE provider = ?",
    )
    .get(provider);
  return (row?.maxPriority || 0) + 1;
}

export function reorderProviderConnectionPriorities(provider) {
  const rows = db()
    .prepare(
      `
    SELECT id
    FROM provider_connections
    WHERE provider = ?
    ORDER BY priority ASC, updated_at DESC
  `,
    )
    .all(provider);
  const stmt = db().prepare(
    "UPDATE provider_connections SET priority = ? WHERE id = ?",
  );
  rows.forEach((row, index) => stmt.run(index + 1, row.id));
}

export function createProviderConnectionRecord(data) {
  const now = nowIso();
  const existing = listProviderConnections({ provider: data.provider }).find(
    (connection) => {
      if (data.authType === "oauth" && data.email) {
        return (
          connection.authType === "oauth" && connection.email === data.email
        );
      }
      if (data.authType === "apikey" && data.name) {
        return (
          connection.authType === "apikey" && connection.name === data.name
        );
      }
      return false;
    },
  );
  if (existing) {
    return updateProviderConnectionRecord(existing.id, data);
  }

  let name = data.name || null;
  if (!name && data.authType === "oauth") {
    if (data.email) name = data.email;
    else
      name = `Account ${listProviderConnections({ provider: data.provider }).length + 1}`;
  }

  const { columnData, extra } = splitConnectionData(data);
  const record = {
    id: data.id || uuidv4(),
    provider: data.provider,
    authType: data.authType || "oauth",
    name,
    priority: nextConnectionPriority(data.provider, data.priority),
    isActive: data.isActive !== undefined ? data.isActive : true,
    createdAt: now,
    updatedAt: now,
    displayName: columnData.displayName ?? null,
    email: columnData.email ?? null,
    globalPriority: columnData.globalPriority ?? null,
    defaultModel: columnData.defaultModel ?? null,
    accessToken: columnData.accessToken ?? null,
    refreshToken: columnData.refreshToken ?? null,
    expiresAt: columnData.expiresAt ?? null,
    tokenType: columnData.tokenType ?? null,
    scope: columnData.scope ?? null,
    idToken: columnData.idToken ?? null,
    projectId: columnData.projectId ?? null,
    apiKey: columnData.apiKey ?? null,
    testStatus: columnData.testStatus ?? null,
    lastTested: columnData.lastTested ?? null,
    lastError: columnData.lastError ?? null,
    lastErrorAt: columnData.lastErrorAt ?? null,
    rateLimitedUntil: columnData.rateLimitedUntil ?? null,
    expiresIn: columnData.expiresIn ?? null,
    errorCode: columnData.errorCode ?? null,
    consecutiveUseCount: columnData.consecutiveUseCount ?? null,
    providerSpecificData: columnData.providerSpecificData || {},
    extra,
  };

  db()
    .prepare(
      `
    INSERT INTO provider_connections (
      id, provider, auth_type, name, priority, is_active, display_name, email,
      global_priority, default_model, access_token, refresh_token, expires_at,
      token_type, scope, id_token, project_id, api_key, test_status, last_tested,
      last_error, last_error_at, rate_limited_until, expires_in, error_code,
      consecutive_use_count, provider_specific_data_json, extra_fields_json,
      created_at, updated_at
    ) VALUES (
      @id, @provider, @authType, @name, @priority, @isActive, @displayName, @email,
      @globalPriority, @defaultModel, @accessToken, @refreshToken, @expiresAt,
      @tokenType, @scope, @idToken, @projectId, @apiKey, @testStatus, @lastTested,
      @lastError, @lastErrorAt, @rateLimitedUntil, @expiresIn, @errorCode,
      @consecutiveUseCount, @providerSpecificDataJson, @extraFieldsJson,
      @createdAt, @updatedAt
    )
  `,
    )
    .run({
      ...record,
      isActive: asBool(record.isActive),
      providerSpecificDataJson: stringifyJson(record.providerSpecificData, {}),
      extraFieldsJson: stringifyJson(record.extra, {}),
    });
  writeConnectionCooldowns(record.id, data);
  reorderProviderConnectionPriorities(record.provider);
  return getProviderConnection(record.id);
}

export function updateProviderConnectionRecord(id, data) {
  const existing = getProviderConnection(id);
  if (!existing) return null;
  const merged = {
    ...existing,
    ...data,
    providerSpecificData: {
      ...(existing.providerSpecificData || {}),
      ...(data.providerSpecificData || {}),
    },
    updatedAt: nowIso(),
  };
  const { columnData, extra } = splitConnectionData(merged);
  db()
    .prepare(
      `
    UPDATE provider_connections
    SET
      provider = @provider,
      auth_type = @authType,
      name = @name,
      priority = @priority,
      is_active = @isActive,
      display_name = @displayName,
      email = @email,
      global_priority = @globalPriority,
      default_model = @defaultModel,
      access_token = @accessToken,
      refresh_token = @refreshToken,
      expires_at = @expiresAt,
      token_type = @tokenType,
      scope = @scope,
      id_token = @idToken,
      project_id = @projectId,
      api_key = @apiKey,
      test_status = @testStatus,
      last_tested = @lastTested,
      last_error = @lastError,
      last_error_at = @lastErrorAt,
      rate_limited_until = @rateLimitedUntil,
      expires_in = @expiresIn,
      error_code = @errorCode,
      consecutive_use_count = @consecutiveUseCount,
      provider_specific_data_json = @providerSpecificDataJson,
      extra_fields_json = @extraFieldsJson,
      updated_at = @updatedAt
    WHERE id = @id
  `,
    )
    .run({
      id,
      provider: merged.provider,
      authType: merged.authType,
      name: merged.name,
      priority: merged.priority,
      isActive: asBool(merged.isActive !== false),
      displayName: columnData.displayName ?? null,
      email: columnData.email ?? null,
      globalPriority: columnData.globalPriority ?? null,
      defaultModel: columnData.defaultModel ?? null,
      accessToken: columnData.accessToken ?? null,
      refreshToken: columnData.refreshToken ?? null,
      expiresAt: columnData.expiresAt ?? null,
      tokenType: columnData.tokenType ?? null,
      scope: columnData.scope ?? null,
      idToken: columnData.idToken ?? null,
      projectId: columnData.projectId ?? null,
      apiKey: columnData.apiKey ?? null,
      testStatus: columnData.testStatus ?? null,
      lastTested: columnData.lastTested ?? null,
      lastError: columnData.lastError ?? null,
      lastErrorAt: columnData.lastErrorAt ?? null,
      rateLimitedUntil: columnData.rateLimitedUntil ?? null,
      expiresIn: columnData.expiresIn ?? null,
      errorCode: columnData.errorCode ?? null,
      consecutiveUseCount: columnData.consecutiveUseCount ?? null,
      providerSpecificDataJson: stringifyJson(
        columnData.providerSpecificData || {},
        {},
      ),
      extraFieldsJson: stringifyJson(extra, {}),
      updatedAt: merged.updatedAt,
    });
  writeConnectionCooldowns(id, data);
  if (data.priority !== undefined)
    reorderProviderConnectionPriorities(existing.provider);
  return getProviderConnection(id);
}

export function deleteProviderConnectionRecord(id) {
  const existing = getProviderConnection(id);
  if (!existing) return false;
  db().prepare("DELETE FROM provider_connections WHERE id = ?").run(id);
  reorderProviderConnectionPriorities(existing.provider);
  return true;
}

export function deleteProviderConnectionsForProvider(provider) {
  const before =
    db()
      .prepare(
        "SELECT COUNT(*) AS count FROM provider_connections WHERE provider = ?",
      )
      .get(provider)?.count || 0;
  db()
    .prepare("DELETE FROM provider_connections WHERE provider = ?")
    .run(provider);
  return before;
}

export function cleanupProviderConnectionRecords() {
  const connections = listProviderConnections();
  let cleaned = 0;
  for (const connection of connections) {
    const next = { ...connection };
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === undefined) {
        delete next[key];
        cleaned += 1;
      }
    }
    if (
      next.providerSpecificData &&
      Object.keys(next.providerSpecificData).length === 0
    ) {
      delete next.providerSpecificData;
      cleaned += 1;
    }
    updateProviderConnectionRecord(connection.id, next);
  }
  return cleaned;
}

export function listModelAliases() {
  const rows = db()
    .prepare(
      "SELECT alias, model_id AS modelId FROM model_aliases ORDER BY alias ASC",
    )
    .all();
  return Object.fromEntries(rows.map((row) => [row.alias, row.modelId]));
}

export function setModelAliasRecord(alias, modelId) {
  db()
    .prepare(
      `
    INSERT INTO model_aliases(alias, model_id)
    VALUES (?, ?)
    ON CONFLICT(alias) DO UPDATE SET model_id = excluded.model_id
  `,
    )
    .run(alias, modelId);
}

export function deleteModelAliasRecord(alias) {
  db().prepare("DELETE FROM model_aliases WHERE alias = ?").run(alias);
}

export function getMitmAliases(toolName) {
  const rows = toolName
    ? db()
        .prepare(
          "SELECT model_alias AS alias, model_id AS modelId FROM mitm_aliases WHERE tool_name = ? ORDER BY model_alias ASC",
        )
        .all(toolName)
    : db()
        .prepare(
          "SELECT tool_name AS toolName, model_alias AS alias, model_id AS modelId FROM mitm_aliases ORDER BY tool_name ASC, model_alias ASC",
        )
        .all();

  if (toolName) {
    return Object.fromEntries(rows.map((row) => [row.alias, row.modelId]));
  }

  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.toolName]) grouped[row.toolName] = {};
    grouped[row.toolName][row.alias] = row.modelId;
  }
  return grouped;
}

export function setMitmAliases(toolName, mappings = {}) {
  const deleteStmt = db().prepare(
    "DELETE FROM mitm_aliases WHERE tool_name = ?",
  );
  const insertStmt = db().prepare(
    "INSERT INTO mitm_aliases(tool_name, model_alias, model_id) VALUES (?, ?, ?)",
  );
  const tx = db().transaction(() => {
    deleteStmt.run(toolName);
    for (const [alias, modelId] of Object.entries(mappings)) {
      insertStmt.run(toolName, alias, modelId);
    }
  });
  tx();
}

function mapCombo(row) {
  if (!row) return null;
  const models = db()
    .prepare(
      `
    SELECT model_id AS modelId
    FROM combo_models
    WHERE combo_id = ?
    ORDER BY position ASC
  `,
    )
    .all(row.id)
    .map((model) => model.modelId);
  return {
    id: row.id,
    name: row.name,
    models,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listCombos() {
  return db()
    .prepare("SELECT * FROM combos ORDER BY name ASC")
    .all()
    .map(mapCombo);
}

export function getComboByIdRecord(id) {
  return mapCombo(db().prepare("SELECT * FROM combos WHERE id = ?").get(id));
}

export function getComboByNameRecord(name) {
  return mapCombo(
    db().prepare("SELECT * FROM combos WHERE name = ?").get(name),
  );
}

export function createComboRecord(data) {
  const now = nowIso();
  const combo = {
    id: data.id || uuidv4(),
    name: data.name,
    models: data.models || [],
    createdAt: now,
    updatedAt: now,
  };
  const tx = db().transaction(() => {
    db()
      .prepare(
        "INSERT INTO combos(id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(combo.id, combo.name, combo.createdAt, combo.updatedAt);
    const insert = db().prepare(
      "INSERT INTO combo_models(combo_id, position, model_id) VALUES (?, ?, ?)",
    );
    combo.models.forEach((modelId, index) =>
      insert.run(combo.id, index, modelId),
    );
  });
  tx();
  return getComboByIdRecord(combo.id);
}

export function updateComboRecord(id, data) {
  const existing = getComboByIdRecord(id);
  if (!existing) return null;
  const next = {
    ...existing,
    ...data,
    models: data.models ?? existing.models,
    updatedAt: nowIso(),
  };
  const tx = db().transaction(() => {
    db()
      .prepare("UPDATE combos SET name = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.updatedAt, id);
    if (data.models) {
      db().prepare("DELETE FROM combo_models WHERE combo_id = ?").run(id);
      const insert = db().prepare(
        "INSERT INTO combo_models(combo_id, position, model_id) VALUES (?, ?, ?)",
      );
      next.models.forEach((modelId, index) => insert.run(id, index, modelId));
    }
  });
  tx();
  return getComboByIdRecord(id);
}

export function deleteComboRecord(id) {
  const existing = getComboByIdRecord(id);
  if (!existing) return false;
  db().prepare("DELETE FROM combos WHERE id = ?").run(id);
  return true;
}

function mapApiKey(row) {
  return row
    ? {
        id: row.id,
        name: row.name,
        key: row.key_value,
        machineId: row.machine_id,
        isActive: fromBool(row.is_active),
        createdAt: row.created_at,
      }
    : null;
}

export function listApiKeys() {
  return db()
    .prepare("SELECT * FROM api_keys ORDER BY created_at DESC")
    .all()
    .map(mapApiKey);
}

export function getApiKeyRecord(id) {
  return mapApiKey(db().prepare("SELECT * FROM api_keys WHERE id = ?").get(id));
}

export function getApiKeyByValue(key) {
  return mapApiKey(
    db().prepare("SELECT * FROM api_keys WHERE key_value = ?").get(key),
  );
}

export function createApiKeyRecord(record) {
  db()
    .prepare(
      `
    INSERT INTO api_keys(id, name, key_value, machine_id, is_active, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      record.id,
      record.name,
      record.key,
      record.machineId || null,
      asBool(record.isActive !== false),
      record.createdAt,
    );
  return getApiKeyRecord(record.id);
}

export function updateApiKeyRecord(id, data) {
  const existing = getApiKeyRecord(id);
  if (!existing) return null;
  const next = { ...existing, ...data };
  db()
    .prepare(
      `
    UPDATE api_keys
    SET name = ?, key_value = ?, machine_id = ?, is_active = ?, created_at = ?
    WHERE id = ?
  `,
    )
    .run(
      next.name,
      next.key,
      next.machineId || null,
      asBool(next.isActive !== false),
      next.createdAt,
      id,
    );
  return getApiKeyRecord(id);
}

export function deleteApiKeyRecord(id) {
  const existing = getApiKeyRecord(id);
  if (!existing) return false;
  db().prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  return true;
}

export function listPricingOverrides() {
  const rows = db()
    .prepare(
      "SELECT provider, model_id AS modelId, pricing_json AS pricingJson FROM pricing_overrides",
    )
    .all();
  const result = {};
  for (const row of rows) {
    if (!result[row.provider]) result[row.provider] = {};
    result[row.provider][row.modelId] = parseJson(row.pricingJson, {});
  }
  return result;
}

export function upsertPricingOverrides(pricingData) {
  const tx = db().transaction(() => {
    const stmt = db().prepare(`
      INSERT INTO pricing_overrides(provider, model_id, pricing_json)
      VALUES (?, ?, ?)
      ON CONFLICT(provider, model_id) DO UPDATE SET pricing_json = excluded.pricing_json
    `);
    for (const [provider, models] of Object.entries(pricingData || {})) {
      for (const [modelId, pricing] of Object.entries(models || {})) {
        stmt.run(provider, modelId, stringifyJson(pricing, {}));
      }
    }
  });
  tx();
  return listPricingOverrides();
}

export function deletePricingOverride(provider, modelId) {
  if (modelId) {
    db()
      .prepare(
        "DELETE FROM pricing_overrides WHERE provider = ? AND model_id = ?",
      )
      .run(provider, modelId);
  } else {
    db()
      .prepare("DELETE FROM pricing_overrides WHERE provider = ?")
      .run(provider);
  }
  return listPricingOverrides();
}

export function resetAllPricingOverrides() {
  db().prepare("DELETE FROM pricing_overrides").run();
  return {};
}

export function insertUsageEvent(entry) {
  db()
    .prepare(
      `
    INSERT INTO usage_events(
      timestamp, provider, model_id, connection_id, api_key_value, endpoint, status,
      prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cache_creation_tokens,
      cost, raw_tokens_json
    ) VALUES (
      @timestamp, @provider, @modelId, @connectionId, @apiKeyValue, @endpoint, @status,
      @promptTokens, @completionTokens, @cachedTokens, @reasoningTokens, @cacheCreationTokens,
      @cost, @rawTokensJson
    )
  `,
    )
    .run({
      timestamp: entry.timestamp,
      provider: entry.provider || null,
      modelId: entry.model || null,
      connectionId: entry.connectionId || null,
      apiKeyValue: entry.apiKey || null,
      endpoint: entry.endpoint || null,
      status: entry.status || null,
      promptTokens:
        entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0,
      completionTokens:
        entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0,
      cachedTokens:
        entry.tokens?.cached_tokens ||
        entry.tokens?.cache_read_input_tokens ||
        0,
      reasoningTokens: entry.tokens?.reasoning_tokens || 0,
      cacheCreationTokens: entry.tokens?.cache_creation_input_tokens || 0,
      cost: entry.cost || 0,
      rawTokensJson: stringifyJson(entry.tokens, {}),
    });
}

export function queryUsageEvents(whereSql = "", params = []) {
  const sql = `
    SELECT
      timestamp,
      provider,
      model_id AS model,
      connection_id AS connectionId,
      api_key_value AS apiKey,
      endpoint,
      status,
      prompt_tokens AS promptTokens,
      completion_tokens AS completionTokens,
      cached_tokens AS cachedTokens,
      reasoning_tokens AS reasoningTokens,
      cache_creation_tokens AS cacheCreationTokens,
      cost,
      raw_tokens_json AS rawTokensJson
    FROM usage_events
    ${whereSql}
    ORDER BY timestamp DESC
  `;
  return db()
    .prepare(sql)
    .all(...params)
    .map((row) => ({
      timestamp: row.timestamp,
      provider: row.provider,
      model: row.model,
      connectionId: row.connectionId,
      apiKey: row.apiKey,
      endpoint: row.endpoint,
      status: row.status,
      cost: row.cost,
      tokens: parseJson(row.rawTokensJson, {
        prompt_tokens: row.promptTokens,
        completion_tokens: row.completionTokens,
        cached_tokens: row.cachedTokens,
        reasoning_tokens: row.reasoningTokens,
        cache_creation_input_tokens: row.cacheCreationTokens,
      }),
    }));
}

export function getUsageEventsCount() {
  return (
    db().prepare("SELECT COUNT(*) AS count FROM usage_events").get()?.count || 0
  );
}

export function getUsageEventSummarySince(timestamp) {
  return db()
    .prepare(
      `
    SELECT
      COUNT(*) AS totalRequests,
      COALESCE(SUM(prompt_tokens), 0) AS totalPromptTokens,
      COALESCE(SUM(completion_tokens), 0) AS totalCompletionTokens,
      COALESCE(SUM(cost), 0) AS totalCost
    FROM usage_events
    WHERE timestamp >= ?
  `,
    )
    .get(timestamp);
}

export function insertRequestLog(record) {
  db()
    .prepare(
      `
    INSERT INTO request_logs(
      timestamp, formatted_timestamp, model_id, provider, connection_id, account_label,
      prompt_tokens, completion_tokens, status, raw_line
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      record.timestamp,
      record.formattedTimestamp,
      record.model,
      record.provider,
      record.connectionId || null,
      record.accountLabel || null,
      record.promptTokens ?? null,
      record.completionTokens ?? null,
      record.status || null,
      record.rawLine,
    );
}

export function listRecentRequestLogs(limit) {
  return db()
    .prepare(
      "SELECT raw_line AS rawLine FROM request_logs ORDER BY timestamp DESC LIMIT ?",
    )
    .all(limit)
    .map((row) => row.rawLine);
}

export function insertOrReplaceRequestDetail(record) {
  db()
    .prepare(
      `
    INSERT INTO request_details(
      id, timestamp, provider, model_id, connection_id, status, latency_json, tokens_json,
      request_json, provider_request_json, provider_response_json, response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      timestamp = excluded.timestamp,
      provider = excluded.provider,
      model_id = excluded.model_id,
      connection_id = excluded.connection_id,
      status = excluded.status,
      latency_json = excluded.latency_json,
      tokens_json = excluded.tokens_json,
      request_json = excluded.request_json,
      provider_request_json = excluded.provider_request_json,
      provider_response_json = excluded.provider_response_json,
      response_json = excluded.response_json
  `,
    )
    .run(
      record.id,
      record.timestamp,
      record.provider || null,
      record.model || null,
      record.connectionId || null,
      record.status || null,
      stringifyJson(record.latency, {}),
      stringifyJson(record.tokens, {}),
      stringifyJson(record.request, {}),
      stringifyJson(record.providerRequest, {}),
      stringifyJson(record.providerResponse, {}),
      stringifyJson(record.response, {}),
    );
}

export function listRequestDetails() {
  return db()
    .prepare("SELECT * FROM request_details ORDER BY timestamp DESC")
    .all()
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      model: row.model_id,
      connectionId: row.connection_id,
      timestamp: row.timestamp,
      status: row.status,
      latency: parseJson(row.latency_json, {}),
      tokens: parseJson(row.tokens_json, {}),
      request: parseJson(row.request_json, {}),
      providerRequest: parseJson(row.provider_request_json, {}),
      providerResponse: parseJson(row.provider_response_json, {}),
      response: parseJson(row.response_json, {}),
    }));
}

function mapRequestDetailRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    provider: row.provider,
    model: row.model_id,
    connectionId: row.connection_id,
    timestamp: row.timestamp,
    status: row.status,
    latency: parseJson(row.latency_json, {}),
    tokens: parseJson(row.tokens_json, {}),
    request: parseJson(row.request_json, {}),
    providerRequest: parseJson(row.provider_request_json, {}),
    providerResponse: parseJson(row.provider_response_json, {}),
    response: parseJson(row.response_json, {}),
  };
}

export function getRequestDetailRecord(id) {
  return mapRequestDetailRow(
    db().prepare("SELECT * FROM request_details WHERE id = ?").get(id),
  );
}
