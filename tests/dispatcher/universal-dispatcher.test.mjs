import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "router-universal-dispatcher-"));
}

async function resetDispatcherTables(tempDir) {
  process.env.DATA_DIR = tempDir;
  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { clearDispatchTables } = await import("@/lib/sqlite/dispatcherStore.js");
  clearDispatchTables();
}

test("dynamically instantiates isolated dispatcher pools for any provider", async () => {
  const tempDir = makeTempDataDir();

  try {
    await resetDispatcherTables(tempDir);
    const { getProviderDispatcher } = await import("@/lib/dispatcher/index.js");

    const openaiDispatcher = getProviderDispatcher("openai");
    const anthropicDispatcher = getProviderDispatcher("anthropic");
    const customNodeDispatcher = getProviderDispatcher("openai-compatible-custom-node");

    assert.ok(openaiDispatcher?.dispatcher);
    assert.ok(anthropicDispatcher?.dispatcher);
    assert.ok(customNodeDispatcher?.dispatcher);

    assert.notEqual(openaiDispatcher, anthropicDispatcher);
    assert.notEqual(openaiDispatcher, customNodeDispatcher);
  } finally {
    const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
    closeSqlite();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
});

test("resolves and patches dynamic provider slots independently", async () => {
  const {
    getDispatcherSlotsPerConnection,
    patchDispatcherSlotsForProvider,
    normalizeDispatcherSlotsByProvider,
  } = await import("@/lib/dispatcher/settings.js");

  const baseSettings = {
    dispatcherSlotsByProvider: {
      codex: 1,
      anthropic: 5,
      openai: 25,
      "custom-node-1": 2,
    },
  };

  assert.equal(getDispatcherSlotsPerConnection(baseSettings, "codex"), 1);
  assert.equal(getDispatcherSlotsPerConnection(baseSettings, "anthropic"), 5);
  assert.equal(getDispatcherSlotsPerConnection(baseSettings, "openai"), 25);
  assert.equal(getDispatcherSlotsPerConnection(baseSettings, "custom-node-1"), 2);

  // Patch a custom provider
  const patch = patchDispatcherSlotsForProvider(baseSettings, "custom-node-1", 10);
  assert.equal(patch.dispatcherSlotsByProvider["custom-node-1"], 10);
  assert.equal(patch.dispatcherSlotsByProvider.openai, 25);
  assert.equal(patch.dispatcherSlotsByProvider.anthropic, 5);
});
