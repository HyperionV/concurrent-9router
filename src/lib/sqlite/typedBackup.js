import {
  importProviderConnections,
  importRequestDetails,
  importUsageEvents,
  listProviderConnections,
  listRequestDetails,
  queryUsageEvents,
} from "@/lib/sqlite/store.js";

const FORMAT = "9router-partial-export";
const VERSION = 1;
const TYPE_ALIASES = {
  full: "full",
  accounts: "accounts",
  "account-list": "accounts",
  accountList: "accounts",
  usage: "usage",
};

export function normalizeExportType(type = "full") {
  const normalized = TYPE_ALIASES[type];
  if (!normalized) {
    throw new Error(`Unsupported export type: ${type}`);
  }
  return normalized;
}

export function buildTypedExportEnvelope(type, data, createdAt = new Date().toISOString()) {
  const normalizedType = normalizeExportType(type);
  return {
    format: FORMAT,
    version: VERSION,
    type: normalizedType,
    createdAt,
    sensitive: normalizedType === "accounts",
    data,
  };
}

export function validateTypedImportPayload(payload, selectedType) {
  const normalizedType = normalizeExportType(selectedType);
  if (normalizedType === "full") return payload;
  if (payload?.format !== FORMAT || payload?.version !== VERSION) {
    throw new Error("Invalid partial export payload");
  }
  if (payload.type !== normalizedType) {
    throw new Error("Backup type does not match selected import type");
  }
  if (!payload.data || typeof payload.data !== "object") {
    throw new Error("Partial export payload is missing data");
  }
  return payload;
}

export function createTypedExportPayload(type) {
  const normalizedType = normalizeExportType(type);
  if (normalizedType === "accounts") {
    return buildTypedExportEnvelope(normalizedType, {
      providerConnections: listProviderConnections(),
    });
  }
  if (normalizedType === "usage") {
    return buildTypedExportEnvelope(normalizedType, {
      usageEvents: queryUsageEvents(),
      requestDetails: listRequestDetails(),
    });
  }
  throw new Error("Full backup export is handled by the SQLite backup route");
}

export function importTypedPayload(payload, selectedType) {
  const envelope = validateTypedImportPayload(payload, selectedType);
  const type = normalizeExportType(selectedType);
  if (type === "accounts") {
    return {
      imported: "accounts",
      providerConnections: importProviderConnections(
        envelope.data.providerConnections || [],
      ),
    };
  }
  if (type === "usage") {
    return {
      imported: "usage",
      usageEvents: importUsageEvents(envelope.data.usageEvents || []),
      requestDetails: importRequestDetails(envelope.data.requestDetails || []),
    };
  }
  throw new Error("Full backup import is handled by the SQLite restore route");
}
