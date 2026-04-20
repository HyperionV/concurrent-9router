import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeSqlite, getSqlite, getSqlitePath } from "@/lib/sqlite/runtime.js";
import { extractBackupToTempFile } from "@/lib/sqlite/backup.js";
import { validateBackupArtifact } from "@/lib/sqlite/validateBackup.js";
import { importLegacyPayload } from "@/lib/sqlite/importLegacy.js";

function isSqliteEnvelope(payload) {
  return (
    payload?.format === "9router-backup" &&
    payload?.engine === "sqlite" &&
    typeof payload?.sqlite?.data === "string"
  );
}

export async function restoreFromBackupPayload(payload) {
  if (isSqliteEnvelope(payload)) {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nine-router-restore-"),
    );
    try {
      const extractedPath = extractBackupToTempFile(payload, tempDir);
      const validation = await validateBackupArtifact(extractedPath);
      if (!validation.valid) {
        throw new Error("Invalid SQLite backup payload");
      }
      closeSqlite();
      fs.copyFileSync(extractedPath, getSqlitePath());
      getSqlite();
      return { restored: "sqlite" };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  await importLegacyPayload(payload);
  return { restored: "legacy-json" };
}
