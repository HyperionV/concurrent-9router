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

describe("backup restore envelope", () => {
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

  it("restores sqlite state from the versioned backup envelope", async () => {
    const dataDir = makeTempDir("nine-router-backup-restore-");
    vi.stubEnv("DATA_DIR", dataDir);

    const localDb = await import("../../src/lib/localDb.js");
    const { getSqlite } = await import("../../src/lib/sqlite/runtime.js");
    const { createBackupArtifact, backupEnvelopeFromFile } =
      await import("../../src/lib/sqlite/backup.js");
    const { restoreFromBackupPayload } =
      await import("../../src/lib/sqlite/restore.js");

    await localDb.updateSettings({ fallbackStrategy: "round-robin" });

    const sqlitePath = path.join(dataDir, "snapshot.sqlite");
    await createBackupArtifact({
      db: getSqlite(),
      destinationPath: sqlitePath,
    });
    const envelope = backupEnvelopeFromFile(sqlitePath);

    await localDb.updateSettings({ fallbackStrategy: "fill-first" });
    await restoreFromBackupPayload(envelope);

    const restored = await localDb.getSettings();
    expect(restored.fallbackStrategy).toBe("round-robin");
  });
});
