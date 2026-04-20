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

describe("sqlite backup", () => {
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

  it("creates a sqlite-native backup that validates against the expected schema", async () => {
    const dataDir = makeTempDir("nine-router-sqlite-backup-");
    vi.stubEnv("DATA_DIR", dataDir);

    const { getSqlite } = await import("../../src/lib/sqlite/runtime.js");
    const { createBackupArtifact } =
      await import("../../src/lib/sqlite/backup.js");
    const { validateBackupArtifact } =
      await import("../../src/lib/sqlite/validateBackup.js");

    const db = getSqlite();
    db.prepare("UPDATE app_settings SET require_login = 0").run();

    const backupPath = path.join(dataDir, "test-backup.sqlite");
    await createBackupArtifact({ db, destinationPath: backupPath });

    expect(fs.existsSync(backupPath)).toBe(true);

    const validation = await validateBackupArtifact(backupPath);
    expect(validation.valid).toBe(true);
    expect(validation.format).toBe("sqlite");
  });

  it("rejects malformed backup files", async () => {
    const dataDir = makeTempDir("nine-router-sqlite-backup-bad-");
    vi.stubEnv("DATA_DIR", dataDir);

    const { validateBackupArtifact } =
      await import("../../src/lib/sqlite/validateBackup.js");

    const brokenPath = path.join(dataDir, "broken.sqlite");
    fs.writeFileSync(brokenPath, "definitely-not-a-real-sqlite-file", "utf8");

    const validation = await validateBackupArtifact(brokenPath);
    expect(validation.valid).toBe(false);
  });
});
