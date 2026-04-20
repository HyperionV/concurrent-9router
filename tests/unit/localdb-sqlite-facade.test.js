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

describe("localDb sqlite facade", () => {
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

  it("normalizes observability aliases and preserves settings contract", async () => {
    const dataDir = makeTempDir("nine-router-localdb-settings-");
    vi.stubEnv("DATA_DIR", dataDir);

    const localDb = await import("../../src/lib/localDb.js");
    const updated = await localDb.updateSettings({
      enableObservability: false,
      fallbackStrategy: "round-robin",
      mitmEnabled: true,
    });

    expect(updated.observabilityEnabled).toBe(false);
    expect(updated.enableObservability).toBe(false);
    expect(updated.fallbackStrategy).toBe("round-robin");
    expect(updated.mitmEnabled).toBe(true);
  });

  it("accepts both model-first and alias-first alias writes", async () => {
    const dataDir = makeTempDir("nine-router-localdb-aliases-");
    vi.stubEnv("DATA_DIR", dataDir);

    const localDb = await import("../../src/lib/localDb.js");
    await localDb.setModelAlias("friendly-a", "gh/gpt-5");
    await localDb.setModelAlias("gh/gpt-4.1", "friendly-b");

    const aliases = await localDb.getModelAliases();
    expect(aliases["friendly-a"]).toBe("gh/gpt-5");
    expect(aliases["friendly-b"]).toBe("gh/gpt-4.1");
  });

  it("persists connection cooldowns as returned modelLock fields", async () => {
    const dataDir = makeTempDir("nine-router-localdb-connections-");
    vi.stubEnv("DATA_DIR", dataDir);

    const localDb = await import("../../src/lib/localDb.js");
    const connection = await localDb.createProviderConnection({
      id: "conn-1",
      provider: "github",
      authType: "oauth",
      name: "Primary",
      modelLock_gpt_5: "2030-01-01T00:00:00.000Z",
      backoffLevel: 2,
    });

    expect(connection.modelLock_gpt_5).toBe("2030-01-01T00:00:00.000Z");
    expect(connection.backoffLevel).toBe(2);

    const fetched = await localDb.getProviderConnectionById("conn-1");
    expect(fetched.modelLock_gpt_5).toBe("2030-01-01T00:00:00.000Z");
    expect(fetched.backoffLevel).toBe(2);
  });
});
