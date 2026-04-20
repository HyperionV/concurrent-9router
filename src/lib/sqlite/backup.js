import fs from "node:fs";
import path from "node:path";
import { getSqlite, getSqlitePath } from "@/lib/sqlite/runtime.js";

export async function createBackupArtifact({
  db = getSqlite(),
  destinationPath,
}) {
  await db.backup(destinationPath);
  return {
    format: "sqlite",
    version: 1,
    databasePath: destinationPath,
    sourcePath: getSqlitePath(),
    createdAt: new Date().toISOString(),
  };
}

export function buildBackupEnvelope({
  databaseBase64,
  createdAt = new Date().toISOString(),
}) {
  return {
    format: "9router-backup",
    version: 2,
    engine: "sqlite",
    createdAt,
    sqlite: {
      encoding: "base64",
      filename: "state.sqlite",
      data: databaseBase64,
    },
  };
}

export function backupEnvelopeFromFile(databasePath) {
  const file = fs.readFileSync(databasePath);
  return buildBackupEnvelope({ databaseBase64: file.toString("base64") });
}

export function writeBackupEnvelopeToFile(envelope, destinationPath) {
  fs.writeFileSync(destinationPath, JSON.stringify(envelope, null, 2), "utf8");
  return destinationPath;
}

export function extractBackupToTempFile(envelope, outputDir) {
  const dbBuffer = Buffer.from(envelope.sqlite.data, "base64");
  const sqlitePath = path.join(
    outputDir,
    envelope.sqlite.filename || "state.sqlite",
  );
  fs.writeFileSync(sqlitePath, dbBuffer);
  return sqlitePath;
}
