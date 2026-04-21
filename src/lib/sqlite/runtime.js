import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR } from "@/lib/dataDir.js";
import { DEFAULT_SETTINGS, normalizeSettings } from "@/lib/sqlite/defaults.js";

const SQLITE_FILE = "state.sqlite";
const RUNTIME_KEY = Symbol.for("nine-router.sqlite.runtime");

function getGlobalRuntime() {
  if (!globalThis[RUNTIME_KEY]) {
    globalThis[RUNTIME_KEY] = {
      db: null,
      dbPath: null,
      initialized: false,
    };
  }
  return globalThis[RUNTIME_KEY];
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  return DATA_DIR;
}

function hasColumn(db, tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}

function ensureColumn(db, tableName, columnName, columnDef) {
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef};`);
  }
}

function getPrimaryKeyColumns(db, tableName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .filter((row) => Number(row.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((row) => row.name);
}

function rebuildDispatchConversationAffinityTable(db) {
  const currentPk = getPrimaryKeyColumns(db, "dispatch_conversation_affinity");
  if (
    currentPk.length === 2 &&
    currentPk[0] === "conversation_key" &&
    currentPk[1] === "api_key_scope"
  ) {
    return;
  }

  db.exec(`
    ALTER TABLE dispatch_conversation_affinity RENAME TO dispatch_conversation_affinity_legacy;

    CREATE TABLE dispatch_conversation_affinity (
      conversation_key TEXT NOT NULL,
      api_key_scope TEXT NOT NULL DEFAULT '__no_key__',
      provider TEXT NOT NULL,
      model_id TEXT,
      connection_id TEXT NOT NULL,
      session_id TEXT,
      api_key_id TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (conversation_key, api_key_scope)
    );

    INSERT INTO dispatch_conversation_affinity(
      conversation_key,
      api_key_scope,
      provider,
      model_id,
      connection_id,
      session_id,
      api_key_id,
      state,
      updated_at
    )
    SELECT
      conversation_key,
      COALESCE(api_key_scope, '__no_key__'),
      provider,
      model_id,
      connection_id,
      session_id,
      api_key_id,
      state,
      updated_at
    FROM dispatch_conversation_affinity_legacy;

    DROP TABLE dispatch_conversation_affinity_legacy;
  `);
}

function runMigrations(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      require_api_key INTEGER NOT NULL DEFAULT 0,
      cloud_enabled INTEGER NOT NULL DEFAULT 0,
      cloud_url TEXT NOT NULL DEFAULT '',
      tunnel_enabled INTEGER NOT NULL DEFAULT 0,
      tunnel_url TEXT NOT NULL DEFAULT '',
      tunnel_provider TEXT NOT NULL DEFAULT 'cloudflare',
      tailscale_enabled INTEGER NOT NULL DEFAULT 0,
      tailscale_url TEXT NOT NULL DEFAULT '',
      fallback_strategy TEXT NOT NULL DEFAULT 'fill-first',
      sticky_round_robin_limit INTEGER NOT NULL DEFAULT 3,
      provider_strategies_json TEXT NOT NULL DEFAULT '{}',
      combo_strategy TEXT NOT NULL DEFAULT 'fallback',
      combo_strategies_json TEXT NOT NULL DEFAULT '{}',
      require_login INTEGER NOT NULL DEFAULT 1,
      tunnel_dashboard_access INTEGER NOT NULL DEFAULT 1,
      observability_enabled INTEGER NOT NULL DEFAULT 1,
      observability_max_records INTEGER NOT NULL DEFAULT 1000,
      observability_batch_size INTEGER NOT NULL DEFAULT 20,
      observability_flush_interval_ms INTEGER NOT NULL DEFAULT 5000,
      observability_max_json_size INTEGER NOT NULL DEFAULT 1024,
      outbound_proxy_enabled INTEGER NOT NULL DEFAULT 0,
      outbound_proxy_url TEXT NOT NULL DEFAULT '',
      outbound_no_proxy TEXT NOT NULL DEFAULT '',
      dispatcher_enabled INTEGER NOT NULL DEFAULT 0,
      dispatcher_shadow_mode INTEGER NOT NULL DEFAULT 0,
      dispatcher_codex_only INTEGER NOT NULL DEFAULT 1,
      codex_default_admission_policy TEXT NOT NULL DEFAULT 'legacy',
      dispatcher_slots_per_connection INTEGER NOT NULL DEFAULT 1,
      mitm_router_base_url TEXT NOT NULL DEFAULT 'http://localhost:20128',
      password TEXT,
      mitm_enabled INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS provider_nodes (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      prefix TEXT,
      api_type TEXT,
      base_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS proxy_pools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      proxy_url TEXT NOT NULL,
      no_proxy TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'http',
      is_active INTEGER NOT NULL DEFAULT 1,
      strict_proxy INTEGER NOT NULL DEFAULT 0,
      test_status TEXT NOT NULL DEFAULT 'unknown',
      last_tested_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS provider_connections (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      auth_type TEXT NOT NULL,
      name TEXT,
      priority INTEGER NOT NULL DEFAULT 1,
      is_active INTEGER NOT NULL DEFAULT 1,
      display_name TEXT,
      email TEXT,
      global_priority INTEGER,
      default_model TEXT,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TEXT,
      token_type TEXT,
      scope TEXT,
      id_token TEXT,
      project_id TEXT,
      api_key TEXT,
      test_status TEXT,
      last_tested TEXT,
      last_error TEXT,
      last_error_at TEXT,
      rate_limited_until TEXT,
      expires_in INTEGER,
      error_code TEXT,
      consecutive_use_count INTEGER,
      provider_specific_data_json TEXT NOT NULL DEFAULT '{}',
      extra_fields_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS provider_connections_provider_name_unique
      ON provider_connections(provider, auth_type, name);
    CREATE INDEX IF NOT EXISTS provider_connections_provider_priority_idx
      ON provider_connections(provider, priority, updated_at DESC);

    CREATE TABLE IF NOT EXISTS connection_model_cooldowns (
      connection_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      locked_until TEXT NOT NULL,
      PRIMARY KEY (connection_id, model_id),
      FOREIGN KEY (connection_id) REFERENCES provider_connections(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS model_aliases (
      alias TEXT PRIMARY KEY,
      model_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mitm_aliases (
      tool_name TEXT NOT NULL,
      model_alias TEXT NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY (tool_name, model_alias)
    );

    CREATE TABLE IF NOT EXISTS combos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS combo_models (
      combo_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY (combo_id, position),
      FOREIGN KEY (combo_id) REFERENCES combos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_value TEXT NOT NULL UNIQUE,
      machine_id TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      codex_admission_policy_override TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pricing_overrides (
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      pricing_json TEXT NOT NULL,
      PRIMARY KEY (provider, model_id)
    );

    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      provider TEXT,
      model_id TEXT,
      connection_id TEXT,
      api_key_value TEXT,
      endpoint TEXT,
      status TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      raw_tokens_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS usage_events_timestamp_idx ON usage_events(timestamp DESC);
    CREATE INDEX IF NOT EXISTS usage_events_provider_idx ON usage_events(provider, timestamp DESC);
    CREATE INDEX IF NOT EXISTS usage_events_connection_idx ON usage_events(connection_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      formatted_timestamp TEXT NOT NULL,
      model_id TEXT,
      provider TEXT,
      connection_id TEXT,
      account_label TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      status TEXT,
      raw_line TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS request_logs_timestamp_idx ON request_logs(timestamp DESC);

    CREATE TABLE IF NOT EXISTS request_details (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      provider TEXT,
      model_id TEXT,
      connection_id TEXT,
      status TEXT,
      latency_json TEXT NOT NULL DEFAULT '{}',
      tokens_json TEXT NOT NULL DEFAULT '{}',
      request_json TEXT NOT NULL DEFAULT '{}',
      routing_json TEXT NOT NULL DEFAULT '{}',
      provider_request_json TEXT NOT NULL DEFAULT '{}',
      provider_response_json TEXT NOT NULL DEFAULT '{}',
      response_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS request_details_timestamp_idx ON request_details(timestamp DESC);

    CREATE TABLE IF NOT EXISTS dispatch_requests (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      source_endpoint TEXT,
      source_format TEXT,
      target_format TEXT,
      conversation_key TEXT,
      request_kind TEXT NOT NULL DEFAULT 'chat',
      status TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      expires_at TEXT,
      completed_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS dispatch_requests_status_idx
      ON dispatch_requests(status, queued_at ASC);
    CREATE INDEX IF NOT EXISTS dispatch_requests_conversation_idx
      ON dispatch_requests(conversation_key, queued_at DESC);

    CREATE TABLE IF NOT EXISTS dispatch_attempts (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      attempt_index INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      connection_id TEXT,
      lease_key TEXT,
      state TEXT NOT NULL,
      path_mode TEXT,
      queue_entered_at TEXT NOT NULL,
      leased_at TEXT,
      connect_started_at TEXT,
      stream_started_at TEXT,
      first_progress_at TEXT,
      last_progress_at TEXT,
      finished_at TEXT,
      timeout_kind TEXT,
      terminal_reason TEXT,
      error_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (request_id) REFERENCES dispatch_requests(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS dispatch_attempts_state_idx
      ON dispatch_attempts(state, queue_entered_at ASC);
    CREATE INDEX IF NOT EXISTS dispatch_attempts_connection_state_idx
      ON dispatch_attempts(connection_id, state);
    CREATE INDEX IF NOT EXISTS dispatch_attempts_request_idx
      ON dispatch_attempts(request_id, attempt_index ASC);

    CREATE TABLE IF NOT EXISTS dispatch_attempt_events (
      id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (attempt_id) REFERENCES dispatch_attempts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS dispatch_attempt_events_attempt_idx
      ON dispatch_attempt_events(attempt_id, at ASC);

    CREATE TABLE IF NOT EXISTS dispatch_conversation_affinity (
      conversation_key TEXT NOT NULL,
      api_key_scope TEXT NOT NULL DEFAULT '__no_key__',
      provider TEXT NOT NULL,
      model_id TEXT,
      connection_id TEXT NOT NULL,
      session_id TEXT,
      api_key_id TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (conversation_key, api_key_scope)
    );

    INSERT OR IGNORE INTO schema_migrations(version, applied_at)
    VALUES ('0001_initial', datetime('now'));
  `);

  ensureColumn(
    db,
    "app_settings",
    "require_api_key",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "app_settings",
    "dispatcher_enabled",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "app_settings",
    "dispatcher_shadow_mode",
    "INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "app_settings",
    "dispatcher_codex_only",
    "INTEGER NOT NULL DEFAULT 1",
  );
  ensureColumn(
    db,
    "app_settings",
    "codex_default_admission_policy",
    "TEXT NOT NULL DEFAULT 'legacy'",
  );
  ensureColumn(
    db,
    "app_settings",
    "dispatcher_slots_per_connection",
    "INTEGER NOT NULL DEFAULT 1",
  );
  ensureColumn(db, "api_keys", "codex_admission_policy_override", "TEXT");
  ensureColumn(
    db,
    "request_details",
    "routing_json",
    "TEXT NOT NULL DEFAULT '{}'",
  );
  ensureColumn(
    db,
    "dispatch_conversation_affinity",
    "api_key_scope",
    "TEXT NOT NULL DEFAULT '__no_key__'",
  );
  ensureColumn(db, "dispatch_conversation_affinity", "api_key_id", "TEXT");
  rebuildDispatchConversationAffinityTable(db);

  db.prepare(
    `
      INSERT OR IGNORE INTO schema_migrations(version, applied_at)
      VALUES ('0002_dispatcher', datetime('now'))
    `,
  ).run();
}

function seedDefaults(db) {
  const settings = normalizeSettings(DEFAULT_SETTINGS);
  db.prepare(
    `
    INSERT OR IGNORE INTO app_settings (
      id,
      require_api_key,
      cloud_enabled,
      cloud_url,
      tunnel_enabled,
      tunnel_url,
      tunnel_provider,
      tailscale_enabled,
      tailscale_url,
      fallback_strategy,
      sticky_round_robin_limit,
      provider_strategies_json,
      combo_strategy,
      combo_strategies_json,
      require_login,
      tunnel_dashboard_access,
      observability_enabled,
      observability_max_records,
      observability_batch_size,
      observability_flush_interval_ms,
      observability_max_json_size,
      outbound_proxy_enabled,
      outbound_proxy_url,
      outbound_no_proxy,
      dispatcher_enabled,
      dispatcher_shadow_mode,
      dispatcher_codex_only,
      codex_default_admission_policy,
      dispatcher_slots_per_connection,
      mitm_router_base_url,
      password,
      mitm_enabled
    ) VALUES (
      1, @requireApiKey, @cloudEnabled, @cloudUrl, @tunnelEnabled, @tunnelUrl, @tunnelProvider,
      @tailscaleEnabled, @tailscaleUrl, @fallbackStrategy, @stickyRoundRobinLimit,
      @providerStrategiesJson, @comboStrategy, @comboStrategiesJson,
      @requireLogin, @tunnelDashboardAccess, @observabilityEnabled,
      @observabilityMaxRecords, @observabilityBatchSize,
      @observabilityFlushIntervalMs, @observabilityMaxJsonSize,
      @outboundProxyEnabled, @outboundProxyUrl, @outboundNoProxy,
      @dispatcherEnabled, @dispatcherShadowMode, @dispatcherCodexOnly, @codexDefaultAdmissionPolicy, @dispatcherSlotsPerConnection,
      @mitmRouterBaseUrl, @password, @mitmEnabled
    )
  `,
  ).run({
    requireApiKey: settings.requireApiKey ? 1 : 0,
    cloudEnabled: settings.cloudEnabled ? 1 : 0,
    cloudUrl: settings.cloudUrl || "",
    tunnelEnabled: settings.tunnelEnabled ? 1 : 0,
    tunnelUrl: settings.tunnelUrl,
    tunnelProvider: settings.tunnelProvider,
    tailscaleEnabled: settings.tailscaleEnabled ? 1 : 0,
    tailscaleUrl: settings.tailscaleUrl,
    fallbackStrategy: settings.fallbackStrategy,
    stickyRoundRobinLimit: settings.stickyRoundRobinLimit,
    providerStrategiesJson: JSON.stringify(settings.providerStrategies || {}),
    comboStrategy: settings.comboStrategy,
    comboStrategiesJson: JSON.stringify(settings.comboStrategies || {}),
    requireLogin: settings.requireLogin ? 1 : 0,
    tunnelDashboardAccess: settings.tunnelDashboardAccess ? 1 : 0,
    observabilityEnabled: settings.observabilityEnabled ? 1 : 0,
    observabilityMaxRecords: settings.observabilityMaxRecords,
    observabilityBatchSize: settings.observabilityBatchSize,
    observabilityFlushIntervalMs: settings.observabilityFlushIntervalMs,
    observabilityMaxJsonSize: settings.observabilityMaxJsonSize,
    outboundProxyEnabled: settings.outboundProxyEnabled ? 1 : 0,
    outboundProxyUrl: settings.outboundProxyUrl,
    outboundNoProxy: settings.outboundNoProxy,
    dispatcherEnabled: settings.dispatcherEnabled ? 1 : 0,
    dispatcherShadowMode: settings.dispatcherShadowMode ? 1 : 0,
    dispatcherCodexOnly: settings.dispatcherCodexOnly !== false ? 1 : 0,
    codexDefaultAdmissionPolicy:
      settings.codexDefaultAdmissionPolicy || "legacy",
    dispatcherSlotsPerConnection: settings.dispatcherSlotsPerConnection ?? 1,
    mitmRouterBaseUrl: settings.mitmRouterBaseUrl,
    password: settings.password || null,
    mitmEnabled: settings.mitmEnabled ? 1 : 0,
  });
}

export function getSqlitePath() {
  return path.join(ensureDataDir(), SQLITE_FILE);
}

export function getSqlite() {
  const runtime = getGlobalRuntime();
  const dbPath = getSqlitePath();

  if (runtime.db && runtime.dbPath === dbPath) {
    return runtime.db;
  }

  const db = new Database(dbPath);
  runMigrations(db);
  seedDefaults(db);

  runtime.db = db;
  runtime.dbPath = dbPath;
  runtime.initialized = true;
  return db;
}

export function closeSqlite() {
  const runtime = getGlobalRuntime();
  if (runtime.db) {
    runtime.db.close();
  }
  runtime.db = null;
  runtime.dbPath = null;
  runtime.initialized = false;
}

export function withTransaction(fn) {
  const db = getSqlite();
  const wrapped = db.transaction(fn);
  return wrapped();
}
