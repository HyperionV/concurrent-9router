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

describe("sqlite bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/sqlite/runtime.js");
    vi.doUnmock("@/lib/sqlite/importLegacy.js");
    vi.unstubAllEnvs();
    vi.resetModules();
    while (tempRoots.length) {
      fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
    }
  });

  it("waits for async legacy import before resolving ensureSqliteReady", async () => {
    const dataDir = makeTempDir("nine-router-sqlite-bootstrap-");
    vi.stubEnv("DATA_DIR", dataDir);
    fs.writeFileSync(
      path.join(dataDir, "db.json"),
      JSON.stringify({ settings: { requireLogin: true } }),
    );

    let importStarted = false;
    let resolveImport;
    const importGate = new Promise((resolve) => {
      resolveImport = resolve;
    });
    const metadata = new Map();

    vi.doMock("@/lib/sqlite/runtime.js", () => ({
      getSqlite: () => ({
        prepare(sql) {
          if (
            sql.includes("SELECT value_json AS valueJson FROM app_metadata")
          ) {
            return {
              get(key) {
                return metadata.has(key)
                  ? { valueJson: JSON.stringify(metadata.get(key)) }
                  : undefined;
              },
            };
          }

          if (sql.includes("INSERT INTO app_metadata(key, value_json)")) {
            return {
              run(key, valueJson) {
                metadata.set(key, JSON.parse(valueJson));
              },
            };
          }

          throw new Error(`Unexpected SQL in bootstrap test: ${sql}`);
        },
      }),
    }));

    vi.doMock("@/lib/sqlite/importLegacy.js", () => ({
      importLegacyPayload: vi.fn(async () => {
        importStarted = true;
        await importGate;
      }),
    }));

    const { ensureSqliteReady } =
      await import("../../src/lib/sqlite/bootstrap.js");

    let resolved = false;
    const readyPromise = ensureSqliteReady().then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(importStarted).toBe(true);
    expect(resolved).toBe(false);

    resolveImport();
    await readyPromise;

    expect(resolved).toBe(true);
    expect(metadata.get("legacy_bootstrap_completed")?.done).toBe(true);
  });
});
