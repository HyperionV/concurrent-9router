import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import {
  createBackupArtifact,
  backupEnvelopeFromFile,
} from "@/lib/sqlite/backup.js";
import { restoreFromBackupPayload } from "@/lib/sqlite/restore.js";
import {
  createTypedExportPayload,
  importTypedPayload,
  normalizeExportType,
} from "@/lib/sqlite/typedBackup.js";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = normalizeExportType(searchParams.get("type") || "full");
    if (type !== "full") {
      return NextResponse.json(createTypedExportPayload(type));
    }

    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "nine-router-export-"),
    );
    const sqlitePath = path.join(tempDir, "state.sqlite");
    await createBackupArtifact({ destinationPath: sqlitePath });
    const payload = backupEnvelopeFromFile(sqlitePath);
    fs.rmSync(tempDir, { recursive: true, force: true });
    return NextResponse.json(payload);
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json(
      { error: "Failed to export database" },
      { status: 500 },
    );
  }
}

export async function POST(request) {
  try {
    const { searchParams } = new URL(request.url);
    const type = normalizeExportType(searchParams.get("type") || "full");
    const payload = await request.json();
    if (type === "full") {
      await restoreFromBackupPayload(payload);
    } else {
      importTypedPayload(payload, type);
    }

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn(
        "[Settings][DatabaseImport] Failed to re-apply outbound proxy env:",
        err,
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 },
    );
  }
}
