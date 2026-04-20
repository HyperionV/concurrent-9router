import test from "node:test";
import assert from "node:assert/strict";

const { getExecutor, hasSpecializedExecutor } =
  await import("../../open-sse/executors/index.js");

test("only codex keeps a specialized executor", () => {
  assert.equal(hasSpecializedExecutor("codex"), true);
  assert.equal(hasSpecializedExecutor("github"), false);
  assert.equal(hasSpecializedExecutor("opencode"), false);
  assert.equal(hasSpecializedExecutor("antigravity"), false);
});

test("removed executors fall back to the default executor", () => {
  assert.equal(getExecutor("codex").constructor.name, "CodexExecutor");
  assert.equal(getExecutor("github").constructor.name, "DefaultExecutor");
  assert.equal(getExecutor("opencode").constructor.name, "DefaultExecutor");
});
