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

describe("usage sqlite facade", () => {
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

  it("stores request usage and exposes usage stats and recent logs", async () => {
    const dataDir = makeTempDir("nine-router-usage-facade-");
    vi.stubEnv("DATA_DIR", dataDir);

    const usageDb = await import("../../src/lib/usageDb.js");
    const localDb = await import("../../src/lib/localDb.js");

    await localDb.createProviderConnection({
      id: "conn-1",
      provider: "github",
      authType: "oauth",
      name: "Primary Account",
    });

    await usageDb.saveRequestUsage({
      provider: "github",
      model: "gpt-5",
      connectionId: "conn-1",
      tokens: { prompt_tokens: 12, completion_tokens: 34 },
      timestamp: "2026-04-19T12:00:00.000Z",
      status: "ok",
      endpoint: "/v1/chat/completions",
    });

    await usageDb.appendRequestLog({
      provider: "github",
      model: "gpt-5",
      connectionId: "conn-1",
      tokens: { prompt_tokens: 12, completion_tokens: 34 },
      status: "ok",
    });

    const stats = await usageDb.getUsageStats("24h");
    const logs = await usageDb.getRecentLogs(10);

    expect(stats.totalRequests).toBe(1);
    expect(stats.totalPromptTokens).toBe(12);
    expect(stats.totalCompletionTokens).toBe(34);
    expect(stats.byProvider.github.requests).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Primary Account");
  });
});
