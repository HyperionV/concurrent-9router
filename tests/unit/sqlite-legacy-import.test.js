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

describe("sqlite legacy import", () => {
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

  it("imports legacy lowdb payload and normalizes observability settings", async () => {
    const dataDir = makeTempDir("nine-router-sqlite-import-");
    vi.stubEnv("DATA_DIR", dataDir);

    const legacyPayload = {
      providerConnections: [
        {
          id: "conn-1",
          provider: "github",
          authType: "oauth",
          name: "Primary",
          priority: 1,
          accessToken: "token-1",
          providerSpecificData: { copilotToken: "copilot-1" },
          modelLock_gpt_4: "2030-01-01T00:00:00.000Z",
        },
      ],
      providerNodes: [
        {
          id: "custom-openai",
          type: "openai-compatible",
          name: "Custom OpenAI",
          prefix: "co",
          apiType: "chat",
          baseUrl: "https://example.com/v1",
        },
      ],
      proxyPools: [
        {
          id: "pool-1",
          name: "Pool One",
          proxyUrl: "http://127.0.0.1:7890",
          isActive: true,
        },
      ],
      modelAliases: {
        "friendly-model": "gh/gpt-5",
      },
      mitmAlias: {
        codex: { "gpt-5": "gh/gpt-5" },
      },
      combos: [
        {
          id: "combo-1",
          name: "primary-stack",
          models: ["gh/gpt-5", "if/kimi-k2-thinking"],
        },
      ],
      apiKeys: [
        {
          id: "key-1",
          name: "Main Key",
          key: "sk-test-key",
          machineId: "machine-1",
          isActive: true,
          createdAt: "2026-04-19T00:00:00.000Z",
        },
      ],
      settings: {
        requireLogin: true,
        outboundProxyEnabled: true,
        outboundProxyUrl: "http://127.0.0.1:7890",
        observabilityEnabled: false,
      },
      pricing: {
        github: {
          "gpt-5": {
            input: 1.2,
            output: 3.4,
          },
        },
      },
    };

    const { getSqlite } = await import("../../src/lib/sqlite/runtime.js");
    const { importLegacyPayload } =
      await import("../../src/lib/sqlite/importLegacy.js");

    const db = getSqlite();
    await importLegacyPayload(legacyPayload, { db });

    const settings = db
      .prepare(
        "SELECT require_login AS requireLogin, observability_enabled AS observabilityEnabled, outbound_proxy_enabled AS outboundProxyEnabled FROM app_settings LIMIT 1",
      )
      .get();
    const combo = db
      .prepare("SELECT name FROM combos WHERE id = ?")
      .get("combo-1");
    const comboModels = db
      .prepare(
        "SELECT model_id AS modelId, position FROM combo_models WHERE combo_id = ? ORDER BY position ASC",
      )
      .all("combo-1");
    const alias = db
      .prepare(
        "SELECT alias, model_id AS modelId FROM model_aliases WHERE alias = ?",
      )
      .get("friendly-model");
    const cooldownRows = db
      .prepare(
        "SELECT connection_id AS connectionId, model_id AS modelId FROM connection_model_cooldowns WHERE connection_id = ?",
      )
      .all("conn-1");

    expect(settings).toMatchObject({
      requireLogin: 1,
      observabilityEnabled: 0,
      outboundProxyEnabled: 1,
    });
    expect(combo?.name).toBe("primary-stack");
    expect(comboModels.map((row) => row.modelId)).toEqual([
      "gh/gpt-5",
      "if/kimi-k2-thinking",
    ]);
    expect(alias).toMatchObject({
      alias: "friendly-model",
      modelId: "gh/gpt-5",
    });
    expect(cooldownRows).toHaveLength(1);
  });
});
