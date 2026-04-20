import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/dataDir.js";
import { getSqlite } from "@/lib/sqlite/runtime.js";
import { importLegacyPayload } from "@/lib/sqlite/importLegacy.js";
import {
  insertOrReplaceRequestDetail,
  insertRequestLog,
  insertUsageEvent,
} from "@/lib/sqlite/store.js";

const LEGACY_BOOTSTRAP_KEY = "legacy_bootstrap_completed";
const LEGACY_DB_FILE = path.join(DATA_DIR, "db.json");
const LEGACY_USAGE_FILE = path.join(DATA_DIR, "usage.json");
const LEGACY_LOG_FILE = path.join(DATA_DIR, "log.txt");
const LEGACY_REQUEST_DETAILS_FILE = path.join(DATA_DIR, "request-details.json");

let bootstrapPromise = null;

function getMetadata(key) {
  const db = getSqlite();
  const row = db
    .prepare("SELECT value_json AS valueJson FROM app_metadata WHERE key = ?")
    .get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.valueJson);
  } catch {
    return null;
  }
}

function setMetadata(key, value) {
  const db = getSqlite();
  db.prepare(
    `
    INSERT INTO app_metadata(key, value_json)
    VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
  `,
  ).run(key, JSON.stringify(value));
}

function parseJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(
      `[sqlite-bootstrap] Failed to parse ${path.basename(filePath)}:`,
      error.message,
    );
    return null;
  }
}

function importLegacyUsage() {
  const payload = parseJsonFile(LEGACY_USAGE_FILE);
  const history = payload?.history;
  if (!Array.isArray(history)) return;
  for (const entry of history) {
    insertUsageEvent(entry);
  }
}

function importLegacyLogs() {
  if (!fs.existsSync(LEGACY_LOG_FILE)) return;
  const lines = fs
    .readFileSync(LEGACY_LOG_FILE, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of lines) {
    insertRequestLog({
      timestamp: new Date().toISOString(),
      formattedTimestamp: line.split("|")[0]?.trim() || "",
      model: null,
      provider: null,
      connectionId: null,
      accountLabel: null,
      promptTokens: null,
      completionTokens: null,
      status: null,
      rawLine: line,
    });
  }
}

function importLegacyRequestDetails() {
  const payload = parseJsonFile(LEGACY_REQUEST_DETAILS_FILE);
  const records = payload?.records;
  if (!Array.isArray(records)) return;
  for (const record of records) {
    insertOrReplaceRequestDetail(record);
  }
}

async function importLegacyIfNeeded() {
  if (getMetadata(LEGACY_BOOTSTRAP_KEY)?.done === true) {
    return;
  }

  if (fs.existsSync(LEGACY_DB_FILE)) {
    const legacyDb = parseJsonFile(LEGACY_DB_FILE);
    if (legacyDb) {
      await importLegacyPayload(legacyDb, { replaceExisting: true });
    }
  }

  importLegacyUsage();
  importLegacyLogs();
  importLegacyRequestDetails();

  setMetadata(LEGACY_BOOTSTRAP_KEY, {
    done: true,
    completedAt: new Date().toISOString(),
  });
}

export async function ensureSqliteReady() {
  if (!bootstrapPromise) {
    bootstrapPromise = Promise.resolve().then(async () => {
      getSqlite();
      await importLegacyIfNeeded();
    });
  }
  return bootstrapPromise;
}
