import { EventEmitter } from "events";
import { ensureSqliteReady } from "@/lib/sqlite/bootstrap.js";
import {
  getUsageChartRows,
  getUsageDashboardRows,
  getUsageEventsCount,
  getUsageMinuteBuckets,
  insertRequestLog,
  insertUsageEvent,
  listRecentRequestLogs,
  listRecentUsageEvents,
  queryUsageEvents,
} from "@/lib/sqlite/store.js";

function getLocalDateKey(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addToCounter(target, key, values) {
  if (!target[key])
    target[key] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    };
  target[key].requests += values.requests || 1;
  target[key].promptTokens += values.promptTokens || 0;
  target[key].completionTokens += values.completionTokens || 0;
  target[key].cost += values.cost || 0;
  if (values.meta) Object.assign(target[key], values.meta);
}

function aggregateEntryToDailySummary(dailySummary, entry) {
  const dateKey = getLocalDateKey(entry.timestamp);
  if (!dailySummary[dateKey]) {
    dailySummary[dateKey] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      byProvider: {},
      byModel: {},
      byAccount: {},
      byApiKey: {},
      byEndpoint: {},
    };
  }
  const day = dailySummary[dateKey];
  const promptTokens =
    entry.tokens?.prompt_tokens || entry.tokens?.input_tokens || 0;
  const completionTokens =
    entry.tokens?.completion_tokens || entry.tokens?.output_tokens || 0;
  const cost = entry.cost || 0;
  const vals = { promptTokens, completionTokens, cost };

  day.requests += 1;
  day.promptTokens += promptTokens;
  day.completionTokens += completionTokens;
  day.cost += cost;

  if (entry.provider) addToCounter(day.byProvider, entry.provider, vals);

  const modelKey = entry.provider
    ? `${entry.model}|${entry.provider}`
    : entry.model;
  addToCounter(day.byModel, modelKey, {
    ...vals,
    meta: { rawModel: entry.model, provider: entry.provider },
  });

  if (entry.connectionId) {
    addToCounter(day.byAccount, entry.connectionId, {
      ...vals,
      meta: { rawModel: entry.model, provider: entry.provider },
    });
  }

  const apiKeyVal =
    entry.apiKey && typeof entry.apiKey === "string"
      ? entry.apiKey
      : "local-no-key";
  const akModelKey = `${apiKeyVal}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byApiKey, akModelKey, {
    ...vals,
    meta: {
      rawModel: entry.model,
      provider: entry.provider,
      apiKey: entry.apiKey || null,
    },
  });

  const endpoint = entry.endpoint || "Unknown";
  const epKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
  addToCounter(day.byEndpoint, epKey, {
    ...vals,
    meta: { endpoint, rawModel: entry.model, provider: entry.provider },
  });
}

// Use global to share pending state across Next.js route modules
if (!global._pendingRequests) {
  global._pendingRequests = { byModel: {}, byAccount: {} };
}
const pendingRequests = global._pendingRequests;

// Track last error provider for UI edge coloring (auto-clears after 10s)
if (!global._lastErrorProvider) {
  global._lastErrorProvider = { provider: "", ts: 0 };
}
const lastErrorProvider = global._lastErrorProvider;

// Use global to share singleton across Next.js route modules
if (!global._statsEmitter) {
  global._statsEmitter = new EventEmitter();
  global._statsEmitter.setMaxListeners(50);
}
export const statsEmitter = global._statsEmitter;

// Safety timers — force-clear pending counts after 1 min if END was never called
if (!global._pendingTimers) global._pendingTimers = {};
const pendingTimers = global._pendingTimers;

const PENDING_TIMEOUT_MS = 60 * 1000; // 1 minute

/**
 * Track a pending request
 * @param {string} model
 * @param {string} provider
 * @param {string} connectionId
 * @param {boolean} started - true if started, false if finished
 * @param {boolean} [error] - true if ended with error
 */
export function trackPendingRequest(
  model,
  provider,
  connectionId,
  started,
  error = false,
) {
  const modelKey = provider ? `${model} (${provider})` : model;
  const timerKey = `${connectionId}|${modelKey}`;

  // Track by model
  if (!pendingRequests.byModel[modelKey]) pendingRequests.byModel[modelKey] = 0;
  pendingRequests.byModel[modelKey] = Math.max(
    0,
    pendingRequests.byModel[modelKey] + (started ? 1 : -1),
  );

  // Track by account
  if (connectionId) {
    if (!pendingRequests.byAccount[connectionId])
      pendingRequests.byAccount[connectionId] = {};
    if (!pendingRequests.byAccount[connectionId][modelKey])
      pendingRequests.byAccount[connectionId][modelKey] = 0;
    pendingRequests.byAccount[connectionId][modelKey] = Math.max(
      0,
      pendingRequests.byAccount[connectionId][modelKey] + (started ? 1 : -1),
    );
  }

  if (started) {
    // Safety timeout: force-clear if END is never called (client disconnect, crash, etc.)
    clearTimeout(pendingTimers[timerKey]);
    pendingTimers[timerKey] = setTimeout(() => {
      delete pendingTimers[timerKey];
      if (pendingRequests.byModel[modelKey] > 0) {
        pendingRequests.byModel[modelKey] = 0;
      }
      if (
        connectionId &&
        pendingRequests.byAccount[connectionId]?.[modelKey] > 0
      ) {
        pendingRequests.byAccount[connectionId][modelKey] = 0;
      }
      statsEmitter.emit("pending");
    }, PENDING_TIMEOUT_MS);
  } else {
    // END called normally — cancel the safety timer
    clearTimeout(pendingTimers[timerKey]);
    delete pendingTimers[timerKey];
  }

  // Track error provider (auto-clears after 10s)
  if (!started && error && provider) {
    lastErrorProvider.provider = provider.toLowerCase();
    lastErrorProvider.ts = Date.now();
  }

  const t = new Date().toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  console.log(
    `[${t}] [PENDING] ${started ? "START" : "END"}${error ? " (ERROR)" : ""} | provider=${provider} | model=${model}`,
  );
  statsEmitter.emit("pending");
}

/**
 * Lightweight: get only activeRequests + recentRequests without full stats recalc
 */
export async function getActiveRequests() {
  await ensureSqliteReady();
  const activeRequests = [];

  // Build active requests from pending state
  let connectionMap = {};
  try {
    const { getProviderConnections } = await import("@/lib/localDb.js");
    const allConnections = await getProviderConnections();
    for (const conn of allConnections) {
      connectionMap[conn.id] = conn.name || conn.email || conn.id;
    }
  } catch {}

  for (const [connectionId, models] of Object.entries(
    pendingRequests.byAccount,
  )) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName =
          connectionMap[connectionId] ||
          `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        const modelName = match ? match[1] : modelKey;
        const providerName = match ? match[2] : "unknown";
        activeRequests.push({
          model: modelName,
          provider: providerName,
          account: accountName,
          count,
        });
      }
    }
  }

  const seen = new Set();
  const recentRequests = listRecentUsageEvents(80)
    .map((e) => ({
      timestamp: e.timestamp,
      model: e.model,
      provider: e.provider || "",
      promptTokens: e.promptTokens || 0,
      completionTokens: e.completionTokens || 0,
      status: e.status || "ok",
    }))
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  // Error provider (auto-clear after 10s)
  const errorProvider =
    Date.now() - lastErrorProvider.ts < 10000 ? lastErrorProvider.provider : "";

  return { activeRequests, recentRequests, errorProvider };
}

/**
 * Get usage database instance (singleton)
 */
export async function getUsageDb() {
  await ensureSqliteReady();
  const history = queryUsageEvents();
  const dailySummary = {};
  for (const entry of history) {
    aggregateEntryToDailySummary(dailySummary, entry);
  }
  return {
    data: {
      history,
      totalRequestsLifetime: getUsageEventsCount(),
      dailySummary,
    },
    read: async () => {},
  };
}

/**
 * Save request usage
 * @param {object} entry - Usage entry { provider, model, tokens: { prompt_tokens, completion_tokens, ... }, connectionId?, apiKey? }
 */
export async function saveRequestUsage(entry) {
  await ensureSqliteReady();
  try {
    if (!entry.timestamp) {
      entry.timestamp = new Date().toISOString();
    }

    const entryCost = await calculateCost(
      entry.provider,
      entry.model,
      entry.tokens,
    );
    entry.cost = entryCost;
    insertUsageEvent(entry);
    statsEmitter.emit("update");
  } catch (error) {
    console.error("Failed to save usage stats:", error);
  }
}

/**
 * Get usage history
 * @param {object} filter - Filter criteria
 */
export async function getUsageHistory(filter = {}) {
  await ensureSqliteReady();
  let history = queryUsageEvents();

  // Apply filters
  if (filter.provider) {
    history = history.filter((h) => h.provider === filter.provider);
  }

  if (filter.model) {
    history = history.filter((h) => h.model === filter.model);
  }

  if (filter.startDate) {
    const start = new Date(filter.startDate).getTime();
    history = history.filter((h) => new Date(h.timestamp).getTime() >= start);
  }

  if (filter.endDate) {
    const end = new Date(filter.endDate).getTime();
    history = history.filter((h) => new Date(h.timestamp).getTime() <= end);
  }

  return history;
}

/**
 * Format date as dd-mm-yyyy h:m:s
 */
function formatLogDate(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const d = pad(date.getDate());
  const m = pad(date.getMonth() + 1);
  const y = date.getFullYear();
  const h = pad(date.getHours());
  const min = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${d}-${m}-${y} ${h}:${min}:${s}`;
}

/**
 * Append to log.txt
 * Format: datetime(dd-mm-yyyy h:m:s) | model | provider | account | tokens sent | tokens received | status
 */
export async function appendRequestLog({
  model,
  provider,
  connectionId,
  tokens,
  status,
}) {
  await ensureSqliteReady();
  try {
    const timestamp = formatLogDate();
    const p = provider?.toUpperCase() || "-";
    const m = model || "-";

    // Resolve account name
    let account = connectionId ? connectionId.slice(0, 8) : "-";
    try {
      const { getProviderConnections } = await import("@/lib/localDb.js");
      const connections = await getProviderConnections();
      const conn = connections.find((c) => c.id === connectionId);
      if (conn) {
        account = conn.name || conn.email || account;
      }
    } catch {}

    const sent =
      tokens?.prompt_tokens !== undefined ? tokens.prompt_tokens : "-";
    const received =
      tokens?.completion_tokens !== undefined ? tokens.completion_tokens : "-";

    const line = `${timestamp} | ${m} | ${p} | ${account} | ${sent} | ${received} | ${status}`;
    insertRequestLog({
      timestamp: new Date().toISOString(),
      formattedTimestamp: timestamp,
      model: m,
      provider: provider || null,
      connectionId,
      accountLabel: account,
      promptTokens: tokens?.prompt_tokens,
      completionTokens: tokens?.completion_tokens,
      status,
      rawLine: line,
    });
  } catch (error) {
    console.error("Failed to append request log:", error.message);
  }
}

/**
 * Get last N lines of log.txt
 */
export async function getRecentLogs(limit = 200) {
  await ensureSqliteReady();
  return listRecentRequestLogs(limit);
}

/**
 * Calculate cost for a usage entry
 * @param {string} provider - Provider ID
 * @param {string} model - Model ID
 * @param {object} tokens - Token counts
 * @returns {number} Cost in dollars
 */
async function calculateCost(provider, model, tokens) {
  if (!tokens || !provider || !model) return 0;

  try {
    const { getPricingForModel } = await import("@/lib/localDb.js");
    const pricing = await getPricingForModel(provider, model);

    if (!pricing) return 0;

    let cost = 0;

    // Input tokens (non-cached)
    const inputTokens = tokens.prompt_tokens || tokens.input_tokens || 0;
    const cachedTokens =
      tokens.cached_tokens || tokens.cache_read_input_tokens || 0;
    const nonCachedInput = Math.max(0, inputTokens - cachedTokens);

    cost += nonCachedInput * (pricing.input / 1000000);

    // Cached tokens
    if (cachedTokens > 0) {
      const cachedRate = pricing.cached || pricing.input; // Fallback to input rate
      cost += cachedTokens * (cachedRate / 1000000);
    }

    // Output tokens
    const outputTokens = tokens.completion_tokens || tokens.output_tokens || 0;
    cost += outputTokens * (pricing.output / 1000000);

    // Reasoning tokens
    const reasoningTokens = tokens.reasoning_tokens || 0;
    if (reasoningTokens > 0) {
      const reasoningRate = pricing.reasoning || pricing.output; // Fallback to output rate
      cost += reasoningTokens * (reasoningRate / 1000000);
    }

    // Cache creation tokens
    const cacheCreationTokens = tokens.cache_creation_input_tokens || 0;
    if (cacheCreationTokens > 0) {
      const cacheCreationRate = pricing.cache_creation || pricing.input; // Fallback to input rate
      cost += cacheCreationTokens * (cacheCreationRate / 1000000);
    }

    return cost;
  } catch (error) {
    console.error("Error calculating cost:", error);
    return 0;
  }
}

const PERIOD_MS = {
  "24h": 86400000,
  "7d": 604800000,
  "30d": 2592000000,
  "60d": 5184000000,
};

/**
 * Get aggregated usage stats
 * @param {"24h"|"7d"|"30d"|"60d"|"all"} period - Time period to filter
 */
function buildConnectionMap(connections) {
  const map = {};
  for (const conn of connections) {
    map[conn.id] = conn.name || conn.email || conn.id;
  }
  return map;
}

function buildProviderNodeNameMap(nodes) {
  const map = {};
  for (const node of nodes) {
    if (node.id && node.name) map[node.id] = node.name;
  }
  return map;
}

function buildApiKeyMap(apiKeys) {
  const map = {};
  for (const key of apiKeys) {
    map[key.key] = {
      name: key.name,
      id: key.id,
      createdAt: key.createdAt,
    };
  }
  return map;
}

function createBaseUsageStats(totalRequests, recentRequests) {
  return {
    totalRequests,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCost: 0,
    byProvider: {},
    byModel: {},
    byAccount: {},
    byApiKey: {},
    byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    recentRequests,
    errorProvider:
      Date.now() - lastErrorProvider.ts < 10000
        ? lastErrorProvider.provider
        : "",
  };
}

function getRecentUsageRequests() {
  const seen = new Set();
  return listRecentUsageEvents(80)
    .map((e) => ({
      timestamp: e.timestamp,
      model: e.model,
      provider: e.provider || "",
      promptTokens: e.promptTokens || 0,
      completionTokens: e.completionTokens || 0,
      status: e.status || "ok",
    }))
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);
}

function attachActiveRequests(stats, connectionMap) {
  for (const [connectionId, models] of Object.entries(
    pendingRequests.byAccount,
  )) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count <= 0) continue;
      const accountName =
        connectionMap[connectionId] || `Account ${connectionId.slice(0, 8)}...`;
      const match = modelKey.match(/^(.*) \((.*)\)$/);
      stats.activeRequests.push({
        model: match ? match[1] : modelKey,
        provider: match ? match[2] : "unknown",
        account: accountName,
        count,
      });
    }
  }
}

function attachLast10Minutes(stats) {
  const now = new Date();
  const currentMinuteStart = new Date(
    Math.floor(now.getTime() / 60000) * 60000,
  );
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const bucketTime = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[new Date(bucketTime).toISOString()] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    };
    stats.last10Minutes.push(bucketMap[new Date(bucketTime).toISOString()]);
  }

  for (const row of getUsageMinuteBuckets(10)) {
    if (!bucketMap[row.minuteKey]) continue;
    bucketMap[row.minuteKey].requests = row.requests || 0;
    bucketMap[row.minuteKey].promptTokens = row.promptTokens || 0;
    bucketMap[row.minuteKey].completionTokens = row.completionTokens || 0;
    bucketMap[row.minuteKey].cost = row.cost || 0;
  }
}

function addAggregatedStats(target, key, row, meta = {}) {
  if (!target[key]) {
    target[key] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
      lastUsed: row.lastUsed,
      ...meta,
    };
  }
  target[key].requests += row.requests || 0;
  target[key].promptTokens += row.promptTokens || 0;
  target[key].completionTokens += row.completionTokens || 0;
  target[key].cost += row.cost || 0;
  if (
    row.lastUsed &&
    (!target[key].lastUsed || row.lastUsed > target[key].lastUsed)
  ) {
    target[key].lastUsed = row.lastUsed;
  }
}

function mergeDashboardRows(
  stats,
  rows,
  connectionMap,
  apiKeyMap,
  providerNodeNameMap,
) {
  for (const row of rows) {
    const provider = row.provider || "";
    const providerDisplayName = providerNodeNameMap[provider] || provider;
    const rawModel = row.model_id || "";

    stats.totalPromptTokens += row.promptTokens || 0;
    stats.totalCompletionTokens += row.completionTokens || 0;
    stats.totalCost += row.cost || 0;

    addAggregatedStats(stats.byProvider, provider || "unknown", row);

    const modelKey = provider ? `${rawModel} (${provider})` : rawModel;
    addAggregatedStats(stats.byModel, modelKey, row, {
      rawModel,
      provider: providerDisplayName,
    });

    if (row.connection_id) {
      const accountName =
        connectionMap[row.connection_id] ||
        `Account ${String(row.connection_id).slice(0, 8)}...`;
      addAggregatedStats(
        stats.byAccount,
        `${rawModel} (${provider} - ${accountName})`,
        row,
        {
          rawModel,
          provider: providerDisplayName,
          connectionId: row.connection_id,
          accountName,
        },
      );
    }

    const apiKeyVal = row.api_key_value;
    const keyInfo = apiKeyVal ? apiKeyMap[apiKeyVal] : null;
    const keyName =
      keyInfo?.name ||
      (apiKeyVal ? `${apiKeyVal.slice(0, 8)}...` : "Local (No API Key)");
    const apiKeyKey = apiKeyVal || "local-no-key";
    addAggregatedStats(
      stats.byApiKey,
      `${apiKeyKey}|${rawModel}|${provider || "unknown"}`,
      row,
      {
        rawModel,
        provider: providerDisplayName,
        apiKey: apiKeyVal,
        keyName,
        apiKeyKey,
      },
    );

    const endpoint = row.endpoint || "Unknown";
    addAggregatedStats(
      stats.byEndpoint,
      `${endpoint}|${rawModel}|${provider || "unknown"}`,
      row,
      {
        endpoint,
        rawModel,
        provider: providerDisplayName,
      },
    );
  }
}

function normalizeChartStep(options = {}) {
  if (options.step !== "custom") {
    return {
      kind: options.step === "hour" ? "hour" : "day",
      unit: options.step === "hour" ? "hour" : "day",
      size: 1,
    };
  }

  const size = Number.parseInt(options.stepSize, 10);
  const unit = options.stepUnit === "hour" ? "hour" : "day";
  if (!Number.isInteger(size) || size < 1 || size > 365) {
    return { error: "Custom chart step must be between 1 and 365" };
  }
  return { kind: "custom", unit, size };
}

export function validateCustomUsageRange(options = {}, step = "day") {
  const start = options.start ? new Date(options.start) : null;
  const end = options.end ? new Date(options.end) : null;
  if (!start || Number.isNaN(start.getTime())) {
    return { error: "Custom range requires a valid start date" };
  }
  if (!end || Number.isNaN(end.getTime())) {
    return { error: "Custom range requires a valid end date" };
  }
  if (start > end) {
    return { error: "Custom range start must be before end" };
  }
  const stepConfig = normalizeChartStep({ ...options, step });
  if (stepConfig.error) return stepConfig;
  const unitMs = stepConfig.unit === "hour" ? 3600000 : 86400000;
  const stepMs = stepConfig.size * unitMs;
  const bucketCount =
    Math.floor((end.getTime() - start.getTime()) / stepMs) + 1;
  if (bucketCount > 1000) {
    return { error: "Custom range is limited to 1000 chart buckets" };
  }
  return {
    range: {
      kind: "custom",
      start: start.toISOString(),
      end: end.toISOString(),
    },
  };
}

function normalizeUsageRange(period = "7d", options = {}) {
  if (period === "custom") {
    const result = validateCustomUsageRange(options);
    if (result.error) throw new Error(result.error);
    return result.range;
  }
  return period;
}

export async function getUsageStats(period = "all", options = {}) {
  await ensureSqliteReady();
  const { getProviderConnections, getApiKeys, getProviderNodes } =
    await import("@/lib/localDb.js");

  const [allConnections, providerNodes, allApiKeys] = await Promise.all([
    getProviderConnections().catch(() => []),
    getProviderNodes().catch(() => []),
    getApiKeys().catch(() => []),
  ]);
  const connectionMap = buildConnectionMap(allConnections);
  const providerNodeNameMap = buildProviderNodeNameMap(providerNodes);
  const apiKeyMap = buildApiKeyMap(allApiKeys);
  const range = normalizeUsageRange(period, options);
  const rows = getUsageDashboardRows(range);
  const stats = createBaseUsageStats(
    getUsageEventsCount(),
    getRecentUsageRequests(),
  );

  attachActiveRequests(stats, connectionMap);
  attachLast10Minutes(stats);
  mergeDashboardRows(
    stats,
    rows,
    connectionMap,
    apiKeyMap,
    providerNodeNameMap,
  );

  return stats;
}

async function getUsageStatsLegacy(period = "all") {
  const db = await getUsageDb();
  const history = db.data.history || [];
  const dailySummary = db.data.dailySummary || {};

  const { getProviderConnections, getApiKeys, getProviderNodes } =
    await import("@/lib/localDb.js");

  let allConnections = [];
  try {
    allConnections = await getProviderConnections();
  } catch {}
  const connectionMap = {};
  for (const conn of allConnections) {
    connectionMap[conn.id] = conn.name || conn.email || conn.id;
  }

  const providerNodeNameMap = {};
  try {
    const nodes = await getProviderNodes();
    for (const node of nodes) {
      if (node.id && node.name) providerNodeNameMap[node.id] = node.name;
    }
  } catch {}

  let allApiKeys = [];
  try {
    allApiKeys = await getApiKeys();
  } catch {}
  const apiKeyMap = {};
  for (const key of allApiKeys) {
    apiKeyMap[key.key] = {
      name: key.name,
      id: key.id,
      createdAt: key.createdAt,
    };
  }

  // Recent requests (always from live history)
  const seen = new Set();
  const recentRequests = [...history]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .map((e) => {
      const t = e.tokens || {};
      return {
        timestamp: e.timestamp,
        model: e.model,
        provider: e.provider || "",
        promptTokens: t.prompt_tokens || t.input_tokens || 0,
        completionTokens: t.completion_tokens || t.output_tokens || 0,
        status: e.status || "ok",
      };
    })
    .filter((e) => {
      if (e.promptTokens === 0 && e.completionTokens === 0) return false;
      const minute = e.timestamp ? e.timestamp.slice(0, 16) : "";
      const key = `${e.model}|${e.provider}|${e.promptTokens}|${e.completionTokens}|${minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 20);

  const lifetimeTotalRequests =
    typeof db.data.totalRequestsLifetime === "number"
      ? db.data.totalRequestsLifetime
      : history.length;

  const stats = {
    totalRequests: lifetimeTotalRequests,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCost: 0,
    byProvider: {},
    byModel: {},
    byAccount: {},
    byApiKey: {},
    byEndpoint: {},
    last10Minutes: [],
    pending: pendingRequests,
    activeRequests: [],
    recentRequests,
    errorProvider:
      Date.now() - lastErrorProvider.ts < 10000
        ? lastErrorProvider.provider
        : "",
  };

  // Active requests from pending
  for (const [connectionId, models] of Object.entries(
    pendingRequests.byAccount,
  )) {
    for (const [modelKey, count] of Object.entries(models)) {
      if (count > 0) {
        const accountName =
          connectionMap[connectionId] ||
          `Account ${connectionId.slice(0, 8)}...`;
        const match = modelKey.match(/^(.*) \((.*)\)$/);
        stats.activeRequests.push({
          model: match ? match[1] : modelKey,
          provider: match ? match[2] : "unknown",
          account: accountName,
          count,
        });
      }
    }
  }

  // last10Minutes — always from live history
  const now = new Date();
  const currentMinuteStart = new Date(
    Math.floor(now.getTime() / 60000) * 60000,
  );
  const tenMinutesAgo = new Date(currentMinuteStart.getTime() - 9 * 60 * 1000);
  const bucketMap = {};
  for (let i = 0; i < 10; i++) {
    const bucketKey = currentMinuteStart.getTime() - (9 - i) * 60 * 1000;
    bucketMap[bucketKey] = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cost: 0,
    };
    stats.last10Minutes.push(bucketMap[bucketKey]);
  }
  for (const entry of history) {
    const entryTime = new Date(entry.timestamp);
    if (entryTime >= tenMinutesAgo && entryTime <= now) {
      const entryMinuteStart = Math.floor(entryTime.getTime() / 60000) * 60000;
      if (bucketMap[entryMinuteStart]) {
        const pt = entry.tokens?.prompt_tokens || 0;
        const ct = entry.tokens?.completion_tokens || 0;
        bucketMap[entryMinuteStart].requests++;
        bucketMap[entryMinuteStart].promptTokens += pt;
        bucketMap[entryMinuteStart].completionTokens += ct;
        bucketMap[entryMinuteStart].cost += entry.cost || 0;
      }
    }
  }

  // Determine if we use dailySummary (7d/30d/60d/all) or live history (24h)
  const useDailySummary = period !== "24h";

  if (useDailySummary) {
    // Collect relevant date keys
    const periodDays = { "7d": 7, "30d": 30, "60d": 60 };
    const maxDays = periodDays[period] || null; // null = all
    const today = new Date();
    const dateKeys = Object.keys(dailySummary).filter((dateKey) => {
      if (!maxDays) return true;
      const parts = dateKey.split("-");
      const d = new Date(
        Number(parts[0]),
        Number(parts[1]) - 1,
        Number(parts[2]),
      );
      const diffDays = Math.floor((today.getTime() - d.getTime()) / 86400000);
      return diffDays < maxDays;
    });

    for (const dateKey of dateKeys) {
      const day = dailySummary[dateKey];
      stats.totalPromptTokens += day.promptTokens || 0;
      stats.totalCompletionTokens += day.completionTokens || 0;
      stats.totalCost += day.cost || 0;

      // Merge byProvider
      for (const [prov, pData] of Object.entries(day.byProvider || {})) {
        if (!stats.byProvider[prov])
          stats.byProvider[prov] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
          };
        stats.byProvider[prov].requests += pData.requests || 0;
        stats.byProvider[prov].promptTokens += pData.promptTokens || 0;
        stats.byProvider[prov].completionTokens += pData.completionTokens || 0;
        stats.byProvider[prov].cost += pData.cost || 0;
      }

      // Merge byModel (dailySummary key: "model|provider" → stats key: "model (provider)")
      for (const [mk, mData] of Object.entries(day.byModel || {})) {
        const rawModel = mData.rawModel || mk.split("|")[0];
        const provider = mData.provider || mk.split("|")[1] || "";
        const statsKey = provider ? `${rawModel} (${provider})` : rawModel;
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byModel[statsKey]) {
          stats.byModel[statsKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
            rawModel,
            provider: providerDisplayName,
            lastUsed: dateKey,
          };
        }
        stats.byModel[statsKey].requests += mData.requests || 0;
        stats.byModel[statsKey].promptTokens += mData.promptTokens || 0;
        stats.byModel[statsKey].completionTokens += mData.completionTokens || 0;
        stats.byModel[statsKey].cost += mData.cost || 0;
        if (dateKey > (stats.byModel[statsKey].lastUsed || ""))
          stats.byModel[statsKey].lastUsed = dateKey;
      }

      // Merge byAccount
      for (const [connId, aData] of Object.entries(day.byAccount || {})) {
        const accountName =
          connectionMap[connId] || `Account ${connId.slice(0, 8)}...`;
        const rawModel = aData.rawModel || "";
        const provider = aData.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const accountKey = `${rawModel} (${provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
            rawModel,
            provider: providerDisplayName,
            connectionId: connId,
            accountName,
            lastUsed: dateKey,
          };
        }
        stats.byAccount[accountKey].requests += aData.requests || 0;
        stats.byAccount[accountKey].promptTokens += aData.promptTokens || 0;
        stats.byAccount[accountKey].completionTokens +=
          aData.completionTokens || 0;
        stats.byAccount[accountKey].cost += aData.cost || 0;
        if (dateKey > (stats.byAccount[accountKey].lastUsed || ""))
          stats.byAccount[accountKey].lastUsed = dateKey;
      }

      // Merge byApiKey
      for (const [akKey, akData] of Object.entries(day.byApiKey || {})) {
        const rawModel = akData.rawModel || "";
        const provider = akData.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        const apiKeyVal = akData.apiKey;
        const keyInfo = apiKeyVal ? apiKeyMap[apiKeyVal] : null;
        const keyName =
          keyInfo?.name ||
          (apiKeyVal ? apiKeyVal.slice(0, 8) + "..." : "Local (No API Key)");
        const apiKeyKey = apiKeyVal || "local-no-key";
        if (!stats.byApiKey[akKey]) {
          stats.byApiKey[akKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
            rawModel,
            provider: providerDisplayName,
            apiKey: apiKeyVal,
            keyName,
            apiKeyKey,
            lastUsed: dateKey,
          };
        }
        stats.byApiKey[akKey].requests += akData.requests || 0;
        stats.byApiKey[akKey].promptTokens += akData.promptTokens || 0;
        stats.byApiKey[akKey].completionTokens += akData.completionTokens || 0;
        stats.byApiKey[akKey].cost += akData.cost || 0;
        if (dateKey > (stats.byApiKey[akKey].lastUsed || ""))
          stats.byApiKey[akKey].lastUsed = dateKey;
      }

      // Merge byEndpoint
      for (const [epKey, epData] of Object.entries(day.byEndpoint || {})) {
        const endpoint = epData.endpoint || epKey.split("|")[0] || "Unknown";
        const rawModel = epData.rawModel || "";
        const provider = epData.provider || "";
        const providerDisplayName = providerNodeNameMap[provider] || provider;
        if (!stats.byEndpoint[epKey]) {
          stats.byEndpoint[epKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
            endpoint,
            rawModel,
            provider: providerDisplayName,
            lastUsed: dateKey,
          };
        }
        stats.byEndpoint[epKey].requests += epData.requests || 0;
        stats.byEndpoint[epKey].promptTokens += epData.promptTokens || 0;
        stats.byEndpoint[epKey].completionTokens +=
          epData.completionTokens || 0;
        stats.byEndpoint[epKey].cost += epData.cost || 0;
        if (dateKey > (stats.byEndpoint[epKey].lastUsed || ""))
          stats.byEndpoint[epKey].lastUsed = dateKey;
      }
    }
  } else {
    // 24h: use live history (original logic)
    const cutoff = Date.now() - PERIOD_MS["24h"];
    const filtered = history.filter(
      (e) => new Date(e.timestamp).getTime() >= cutoff,
    );

    for (const entry of filtered) {
      const promptTokens = entry.tokens?.prompt_tokens || 0;
      const completionTokens = entry.tokens?.completion_tokens || 0;
      const entryCost = entry.cost || 0;
      const providerDisplayName =
        providerNodeNameMap[entry.provider] || entry.provider;

      stats.totalPromptTokens += promptTokens;
      stats.totalCompletionTokens += completionTokens;
      stats.totalCost += entryCost;

      // byProvider
      if (!stats.byProvider[entry.provider])
        stats.byProvider[entry.provider] = {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cost: 0,
        };
      stats.byProvider[entry.provider].requests++;
      stats.byProvider[entry.provider].promptTokens += promptTokens;
      stats.byProvider[entry.provider].completionTokens += completionTokens;
      stats.byProvider[entry.provider].cost += entryCost;

      // byModel
      const modelKey = entry.provider
        ? `${entry.model} (${entry.provider})`
        : entry.model;
      if (!stats.byModel[modelKey]) {
        stats.byModel[modelKey] = {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cost: 0,
          rawModel: entry.model,
          provider: providerDisplayName,
          lastUsed: entry.timestamp,
        };
      }
      stats.byModel[modelKey].requests++;
      stats.byModel[modelKey].promptTokens += promptTokens;
      stats.byModel[modelKey].completionTokens += completionTokens;
      stats.byModel[modelKey].cost += entryCost;
      if (
        new Date(entry.timestamp) > new Date(stats.byModel[modelKey].lastUsed)
      )
        stats.byModel[modelKey].lastUsed = entry.timestamp;

      // byAccount
      if (entry.connectionId) {
        const accountName =
          connectionMap[entry.connectionId] ||
          `Account ${entry.connectionId.slice(0, 8)}...`;
        const accountKey = `${entry.model} (${entry.provider} - ${accountName})`;
        if (!stats.byAccount[accountKey]) {
          stats.byAccount[accountKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
            rawModel: entry.model,
            provider: providerDisplayName,
            connectionId: entry.connectionId,
            accountName,
            lastUsed: entry.timestamp,
          };
        }
        stats.byAccount[accountKey].requests++;
        stats.byAccount[accountKey].promptTokens += promptTokens;
        stats.byAccount[accountKey].completionTokens += completionTokens;
        stats.byAccount[accountKey].cost += entryCost;
        if (
          new Date(entry.timestamp) >
          new Date(stats.byAccount[accountKey].lastUsed)
        )
          stats.byAccount[accountKey].lastUsed = entry.timestamp;
      }

      // byApiKey
      if (entry.apiKey && typeof entry.apiKey === "string") {
        const keyInfo = apiKeyMap[entry.apiKey];
        const keyName = keyInfo?.name || entry.apiKey.slice(0, 8) + "...";
        const apiKeyModelKey = `${entry.apiKey}|${entry.model}|${entry.provider || "unknown"}`;
        if (!stats.byApiKey[apiKeyModelKey]) {
          stats.byApiKey[apiKeyModelKey] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
            rawModel: entry.model,
            provider: providerDisplayName,
            apiKey: entry.apiKey,
            keyName,
            apiKeyKey: entry.apiKey,
            lastUsed: entry.timestamp,
          };
        }
        const ake = stats.byApiKey[apiKeyModelKey];
        ake.requests++;
        ake.promptTokens += promptTokens;
        ake.completionTokens += completionTokens;
        ake.cost += entryCost;
        if (new Date(entry.timestamp) > new Date(ake.lastUsed))
          ake.lastUsed = entry.timestamp;
      } else {
        if (!stats.byApiKey["local-no-key"]) {
          stats.byApiKey["local-no-key"] = {
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
            cost: 0,
            rawModel: entry.model,
            provider: providerDisplayName,
            apiKey: null,
            keyName: "Local (No API Key)",
            apiKeyKey: "local-no-key",
            lastUsed: entry.timestamp,
          };
        }
        const ake = stats.byApiKey["local-no-key"];
        ake.requests++;
        ake.promptTokens += promptTokens;
        ake.completionTokens += completionTokens;
        ake.cost += entryCost;
        if (new Date(entry.timestamp) > new Date(ake.lastUsed))
          ake.lastUsed = entry.timestamp;
      }

      // byEndpoint
      const endpoint = entry.endpoint || "Unknown";
      const endpointModelKey = `${endpoint}|${entry.model}|${entry.provider || "unknown"}`;
      if (!stats.byEndpoint[endpointModelKey]) {
        stats.byEndpoint[endpointModelKey] = {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          cost: 0,
          endpoint,
          rawModel: entry.model,
          provider: providerDisplayName,
          lastUsed: entry.timestamp,
        };
      }
      const epe = stats.byEndpoint[endpointModelKey];
      epe.requests++;
      epe.promptTokens += promptTokens;
      epe.completionTokens += completionTokens;
      epe.cost += entryCost;
      if (new Date(entry.timestamp) > new Date(epe.lastUsed))
        epe.lastUsed = entry.timestamp;
    }
  }

  return stats;
}

const CHART_STEP_MS = {
  hour: 3600000,
  day: 86400000,
};

function getDefaultChartWindow(period) {
  const now = Date.now();
  if (period === "24h")
    return { startMs: now - 23 * CHART_STEP_MS.hour, endMs: now };
  const daysByPeriod = { "7d": 7, "30d": 30, "60d": 60 };
  const days = daysByPeriod[period] || daysByPeriod["7d"];
  return { startMs: now - (days - 1) * CHART_STEP_MS.day, endMs: now };
}

function getChartWindow(period, options) {
  if (period === "custom") {
    const range = normalizeUsageRange(period, options);
    return {
      startMs: new Date(range.start).getTime(),
      endMs: new Date(range.end).getTime(),
    };
  }
  return getDefaultChartWindow(period);
}

function getChartBucketLabel(timestampMs, stepConfig) {
  const d = new Date(timestampMs);
  if (stepConfig.unit === "hour") {
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function alignChartBucket(timestampMs, stepMs) {
  return Math.floor(timestampMs / stepMs) * stepMs;
}

export async function getChartData(period = "7d", options = {}) {
  await ensureSqliteReady();
  const stepConfig = normalizeChartStep(options);
  if (stepConfig.error) throw new Error(stepConfig.error);
  const stepMs = stepConfig.size * CHART_STEP_MS[stepConfig.unit];
  const { startMs, endMs } = getChartWindow(period, options);
  const bucketStartMs = alignChartBucket(startMs, stepMs);
  const bucketEndMs = alignChartBucket(endMs, stepMs);
  const range =
    period === "custom"
      ? normalizeUsageRange(period, options)
      : {
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
        };
  const buckets = new Map();

  for (let ts = bucketStartMs; ts <= bucketEndMs; ts += stepMs) {
    buckets.set(ts, {
      label: getChartBucketLabel(ts, stepConfig),
      tokens: 0,
      cost: 0,
    });
  }

  for (const row of getUsageChartRows(range, stepConfig)) {
    const rowMs = new Date(row.bucketKey).getTime();
    if (Number.isNaN(rowMs)) continue;
    const bucketMs = alignChartBucket(rowMs, stepMs);
    const bucket = buckets.get(bucketMs);
    if (!bucket) continue;
    bucket.tokens += row.tokens || 0;
    bucket.cost += row.cost || 0;
  }

  return [...buckets.values()];
}

// Re-export request details functions from new SQLite-based module
export {
  saveRequestDetail,
  getRequestDetails,
  getRequestDetailById,
} from "./requestDetailsDb.js";
