import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tempRoots = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

describe("sqlite runtime", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    return import("../../src/lib/sqlite/runtime.js")
      .then(({ closeSqlite }) => closeSqlite())
      .catch(() => {})
      .finally(() => {
        vi.resetModules();
        while (tempRoots.length) {
          fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
        }
      });
  });

  it("creates the sqlite runtime database and metadata tables", async () => {
    const dataDir = makeTempDir("nine-router-sqlite-runtime-");
    vi.stubEnv("DATA_DIR", dataDir);

    const { getSqlite } = await import("../../src/lib/sqlite/runtime.js");
    const db = getSqlite();

    const sqlitePath = path.join(dataDir, "state.sqlite");
    expect(fs.existsSync(sqlitePath)).toBe(true);

    const migrationRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("schema_migrations");
    const metadataRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("app_metadata");
    const settingsRow = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get("app_settings");

    expect(migrationRow?.name).toBe("schema_migrations");
    expect(metadataRow?.name).toBe("app_metadata");
    expect(settingsRow?.name).toBe("app_settings");
  });

  it("applies wal mode and foreign key pragmas", async () => {
    const dataDir = makeTempDir("nine-router-sqlite-pragmas-");
    vi.stubEnv("DATA_DIR", dataDir);

    const { getSqlite } = await import("../../src/lib/sqlite/runtime.js");
    const db = getSqlite();

    const journalMode = db.pragma("journal_mode", { simple: true });
    const foreignKeys = db.pragma("foreign_keys", { simple: true });

    expect(String(journalMode).toLowerCase()).toBe("wal");
    expect(foreignKeys).toBe(1);
  });
});
