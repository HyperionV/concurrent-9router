import fs from "node:fs";
import Database from "better-sqlite3";

export async function validateBackupArtifact(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: "missing_file" };
    }

    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    try {
      const requiredTables = ["schema_migrations", "app_settings"];
      for (const tableName of requiredTables) {
        const row = db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(tableName);
        if (!row) {
          return { valid: false, reason: `missing_table:${tableName}` };
        }
      }
      return { valid: true, format: "sqlite" };
    } finally {
      db.close();
    }
  } catch {
    return { valid: false, reason: "invalid_sqlite" };
  }
}
