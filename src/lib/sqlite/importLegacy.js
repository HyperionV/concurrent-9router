import { getSqlite } from "@/lib/sqlite/runtime.js";
import {
  createProviderConnectionRecord,
  createProviderNodeRecord,
  createProxyPoolRecord,
  createComboRecord,
  createApiKeyRecord,
  resetAllPricingOverrides,
  setMitmAliases,
  setModelAliasRecord,
  upsertPricingOverrides,
  writeSettings,
} from "@/lib/sqlite/store.js";

function clearAllTables(db) {
  db.exec(`
    DELETE FROM connection_model_cooldowns;
    DELETE FROM provider_connections;
    DELETE FROM provider_nodes;
    DELETE FROM proxy_pools;
    DELETE FROM model_aliases;
    DELETE FROM mitm_aliases;
    DELETE FROM combo_models;
    DELETE FROM combos;
    DELETE FROM api_keys;
    DELETE FROM pricing_overrides;
    DELETE FROM usage_events;
    DELETE FROM request_logs;
    DELETE FROM request_details;
  `);
}

export async function importLegacyPayload(
  payload,
  { db = getSqlite(), replaceExisting = true } = {},
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid legacy payload");
  }

  const tx = db.transaction(() => {
    if (replaceExisting) clearAllTables(db);

    writeSettings(payload.settings || {});

    for (const node of payload.providerNodes || []) {
      createProviderNodeRecord(node);
    }

    for (const pool of payload.proxyPools || []) {
      createProxyPoolRecord(pool);
    }

    for (const connection of payload.providerConnections || []) {
      createProviderConnectionRecord(connection);
    }

    for (const [alias, modelId] of Object.entries(payload.modelAliases || {})) {
      setModelAliasRecord(alias, modelId);
    }

    for (const [toolName, mappings] of Object.entries(
      payload.mitmAlias || {},
    )) {
      setMitmAliases(toolName, mappings);
    }

    for (const combo of payload.combos || []) {
      createComboRecord(combo);
    }

    for (const apiKey of payload.apiKeys || []) {
      createApiKeyRecord(apiKey);
    }

    resetAllPricingOverrides();
    upsertPricingOverrides(payload.pricing || {});
  });

  tx();
}
