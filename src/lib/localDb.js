import { v4 as uuidv4 } from "uuid";
import { ensureSqliteReady } from "@/lib/sqlite/bootstrap.js";
import {
  cleanupProviderConnectionRecords,
  createApiKeyRecord,
  createComboRecord,
  createProviderConnectionRecord,
  createProviderNodeRecord,
  createProxyPoolRecord,
  deleteApiKeyRecord,
  deleteComboRecord,
  deleteModelAliasRecord,
  deletePricingOverride,
  deleteProviderConnectionRecord,
  deleteProviderConnectionsForProvider,
  deleteProviderNodeRecord,
  deleteProxyPoolRecord,
  getApiKeyByValue,
  getApiKeyRecord,
  getComboByIdRecord,
  getComboByNameRecord,
  getMitmAliases,
  getProviderConnection,
  getProviderNode,
  getProxyPool,
  listApiKeys,
  listCombos,
  listModelAliases,
  listPricingOverrides,
  listProviderConnections,
  listProviderNodes,
  listProxyPools,
  readSettings,
  reorderProviderConnectionPriorities,
  resetAllPricingOverrides,
  setMitmAliases,
  setModelAliasRecord,
  updateApiKeyRecord,
  updateComboRecord,
  updateProviderConnectionRecord,
  updateProviderNodeRecord,
  updateProxyPoolRecord,
  upsertPricingOverrides,
  writeSettings,
} from "@/lib/sqlite/store.js";

function normalizeAliasArgs(first, second) {
  const firstLooksLikeModel = typeof first === "string" && first.includes("/");
  const secondLooksLikeModel =
    typeof second === "string" && second.includes("/");
  if (firstLooksLikeModel && !secondLooksLikeModel) {
    return { alias: second, model: first };
  }
  return { alias: first, model: second };
}

function cloneDefaultData() {
  return {
    providerConnections: [],
    providerNodes: [],
    proxyPools: [],
    modelAliases: {},
    mitmAlias: {},
    combos: [],
    apiKeys: [],
    settings: readSettings(),
    pricing: {},
  };
}

export async function getDb() {
  await ensureSqliteReady();
  return {
    data: {
      providerConnections: listProviderConnections(),
      providerNodes: listProviderNodes(),
      proxyPools: listProxyPools(),
      modelAliases: listModelAliases(),
      mitmAlias: getMitmAliases(),
      combos: listCombos(),
      apiKeys: listApiKeys(),
      settings: readSettings(),
      pricing: listPricingOverrides(),
    },
  };
}

export async function getProviderConnections(filter = {}) {
  await ensureSqliteReady();
  return listProviderConnections(filter);
}

export async function getProviderNodes(filter = {}) {
  await ensureSqliteReady();
  return listProviderNodes(filter);
}

export async function getProviderNodeById(id) {
  await ensureSqliteReady();
  return getProviderNode(id);
}

export async function createProviderNode(data) {
  await ensureSqliteReady();
  return createProviderNodeRecord(data);
}

export async function updateProviderNode(id, data) {
  await ensureSqliteReady();
  return updateProviderNodeRecord(id, data);
}

export async function deleteProviderNode(id) {
  await ensureSqliteReady();
  return deleteProviderNodeRecord(id);
}

export async function getProxyPools(filter = {}) {
  await ensureSqliteReady();
  return listProxyPools(filter);
}

export async function getProxyPoolById(id) {
  await ensureSqliteReady();
  return getProxyPool(id);
}

export async function createProxyPool(data) {
  await ensureSqliteReady();
  return createProxyPoolRecord(data);
}

export async function updateProxyPool(id, data) {
  await ensureSqliteReady();
  return updateProxyPoolRecord(id, data);
}

export async function deleteProxyPool(id) {
  await ensureSqliteReady();
  return deleteProxyPoolRecord(id);
}

export async function deleteProviderConnectionsByProvider(providerId) {
  await ensureSqliteReady();
  return deleteProviderConnectionsForProvider(providerId);
}

export async function getProviderConnectionById(id) {
  await ensureSqliteReady();
  return getProviderConnection(id);
}

export async function createProviderConnection(data) {
  await ensureSqliteReady();
  return createProviderConnectionRecord({ id: data.id || uuidv4(), ...data });
}

export async function updateProviderConnection(id, data) {
  await ensureSqliteReady();
  return updateProviderConnectionRecord(id, data);
}

export async function deleteProviderConnection(id) {
  await ensureSqliteReady();
  return deleteProviderConnectionRecord(id);
}

export async function reorderProviderConnections(providerId) {
  await ensureSqliteReady();
  reorderProviderConnectionPriorities(providerId);
}

export async function getModelAliases() {
  await ensureSqliteReady();
  return listModelAliases();
}

export async function setModelAlias(alias, model) {
  await ensureSqliteReady();
  const normalized = normalizeAliasArgs(alias, model);
  setModelAliasRecord(normalized.alias, normalized.model);
}

export async function deleteModelAlias(alias) {
  await ensureSqliteReady();
  deleteModelAliasRecord(alias);
}

export async function getMitmAlias(toolName) {
  await ensureSqliteReady();
  return getMitmAliases(toolName);
}

export async function setMitmAliasAll(toolName, mappings) {
  await ensureSqliteReady();
  setMitmAliases(toolName, mappings || {});
}

export async function getCombos() {
  await ensureSqliteReady();
  return listCombos();
}

export async function getComboById(id) {
  await ensureSqliteReady();
  return getComboByIdRecord(id);
}

export async function getComboByName(name) {
  await ensureSqliteReady();
  return getComboByNameRecord(name);
}

export async function createCombo(data) {
  await ensureSqliteReady();
  return createComboRecord({ id: data.id || uuidv4(), ...data });
}

export async function updateCombo(id, data) {
  await ensureSqliteReady();
  return updateComboRecord(id, data);
}

export async function deleteCombo(id) {
  await ensureSqliteReady();
  return deleteComboRecord(id);
}

export async function getApiKeys() {
  await ensureSqliteReady();
  return listApiKeys();
}

function generateShortKey() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export async function createApiKey(
  name,
  machineId,
  { codexAdmissionPolicyOverride = null } = {},
) {
  if (!machineId) throw new Error("machineId is required");

  await ensureSqliteReady();
  const now = new Date().toISOString();

  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);

  const apiKey = {
    id: uuidv4(),
    name: name,
    key: result.key,
    machineId: machineId,
    isActive: true,
    codexAdmissionPolicyOverride,
    createdAt: now,
  };

  return createApiKeyRecord(apiKey);
}

export async function deleteApiKey(id) {
  await ensureSqliteReady();
  return deleteApiKeyRecord(id);
}

export async function getApiKeyById(id) {
  await ensureSqliteReady();
  return getApiKeyRecord(id);
}

export async function updateApiKey(id, data) {
  await ensureSqliteReady();
  return updateApiKeyRecord(id, data);
}

export async function validateApiKey(key) {
  await ensureSqliteReady();
  const found = getApiKeyByValue(key);
  return found && found.isActive !== false;
}

export async function getActiveApiKeyRecordByValue(key) {
  await ensureSqliteReady();
  if (!key) return null;
  const found = getApiKeyByValue(key);
  if (!found || found.isActive === false) return null;
  return found;
}

export async function cleanupProviderConnections() {
  await ensureSqliteReady();
  return cleanupProviderConnectionRecords();
}

export async function getSettings() {
  await ensureSqliteReady();
  return readSettings();
}

export async function updateSettings(updates) {
  await ensureSqliteReady();
  return writeSettings(updates);
}

export async function exportDb() {
  const db = await getDb();
  return db.data || cloneDefaultData();
}

export async function importDb(payload) {
  await ensureSqliteReady();
  const { importLegacyPayload } = await import("@/lib/sqlite/importLegacy.js");
  await importLegacyPayload(payload);
  return exportDb();
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function getPricing() {
  await ensureSqliteReady();
  const userPricing = listPricingOverrides();
  const { PROVIDER_PRICING } = await import("@/shared/constants/pricing.js");

  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;

  await ensureSqliteReady();
  const userPricing = listPricingOverrides();

  if (provider && userPricing[provider]?.[model]) {
    return userPricing[provider][model];
  }

  const { getPricingForModel: resolve } =
    await import("@/shared/constants/pricing.js");
  return resolve(provider, model);
}

export async function updatePricing(pricingData) {
  await ensureSqliteReady();
  return upsertPricingOverrides(pricingData);
}

export async function resetPricing(provider, model) {
  await ensureSqliteReady();
  return deletePricingOverride(provider, model);
}

export async function resetAllPricing() {
  await ensureSqliteReady();
  return resetAllPricingOverrides();
}
