import test from "node:test";
import assert from "node:assert/strict";
import { getPublicModelsList, resolveModelCapabilities } from "../../src/lib/publicModels.js";
import {
  createPublicModelRecord,
  getPublicModelRecord,
  updatePublicModelRecord,
  deletePublicModelRecord,
  listPublicModelRecords,
} from "../../src/lib/sqlite/store.js";

test("resolveModelCapabilities identifies reasoning support and context windows", () => {
  // Grok 4.7
  const grokCaps = resolveModelCapabilities("grok-cli", "grok-4.7");
  assert.equal(grokCaps.capabilities.reasoning, true);
  assert.equal(grokCaps.capabilities.vision, true);
  assert.deepEqual(grokCaps.reasoning_efforts, ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(grokCaps.default_reasoning_effort, "high");
  assert.equal(grokCaps.context_window, 131072);

  // Codex GPT-6
  const codexCaps = resolveModelCapabilities("codex", "gpt-6.0-sol");
  assert.equal(codexCaps.capabilities.reasoning, true);
  assert.deepEqual(codexCaps.reasoning_efforts, ["none", "low", "medium", "high", "xhigh"]);
  assert.equal(codexCaps.default_reasoning_effort, "high");
  assert.equal(codexCaps.context_window, 200000);

  // Claude Opus 5.5
  const claudeCaps = resolveModelCapabilities("claude", "claude-opus-5-5");
  assert.equal(claudeCaps.capabilities.reasoning, true);
  assert.deepEqual(claudeCaps.reasoning_efforts, ["low", "medium", "high", "max"]);
  assert.equal(claudeCaps.max_output_tokens, 64000);
});

test("user-defined public models CRUD lifecycle and public API rendering", async () => {
  const testId = `test-pub-model-${Date.now()}`;

  // 1. Create
  const created = createPublicModelRecord({
    id: testId,
    name: "Grok 4.7 Reasoning Custom",
    targetModel: "gcli/grok-4.7",
    description: "Flagship custom endpoint",
    provider: "grok-cli",
    providerDisplay: "Grok CLI",
    contextWindow: 131072,
    maxOutputTokens: 64000,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "high",
    isActive: true,
  });

  assert.ok(created);
  assert.equal(created.id, testId);
  assert.equal(created.name, "Grok 4.7 Reasoning Custom");
  assert.equal(created.targetModel, "gcli/grok-4.7");
  assert.equal(created.isActive, true);
  assert.deepEqual(created.reasoningEfforts, ["low", "medium", "high", "xhigh", "max"]);

  // 2. Read from store
  const fetched = getPublicModelRecord(testId);
  assert.equal(fetched.name, "Grok 4.7 Reasoning Custom");

  // 3. Verify public list contains the active record
  const publicList = await getPublicModelsList();
  assert.equal(publicList.object, "list");
  const publicItem = publicList.data.find((d) => d.entry_id === testId);
  assert.ok(publicItem);
  assert.equal(publicItem.name, "Grok 4.7 Reasoning Custom");
  assert.equal(publicItem.id, "gcli/grok-4.7");
  assert.equal(publicItem.default_reasoning_effort, "high");
  assert.deepEqual(publicItem.reasoning_efforts, ["low", "medium", "high", "xhigh", "max"]);

  // 4. Update
  const updated = updatePublicModelRecord(testId, {
    name: "Grok 4.7 Reasoning Updated",
    isActive: false, // deactivate
  });
  assert.equal(updated.name, "Grok 4.7 Reasoning Updated");
  assert.equal(updated.isActive, false);

  // Inactive model should NOT appear in public active endpoint list
  const publicListAfterDeactivation = await getPublicModelsList();
  const inactiveItem = publicListAfterDeactivation.data.find((d) => d.entry_id === testId);
  assert.equal(inactiveItem, undefined);

  // 5. Delete
  const deleted = deletePublicModelRecord(testId);
  assert.equal(deleted, true);
  assert.equal(getPublicModelRecord(testId), null);
});
