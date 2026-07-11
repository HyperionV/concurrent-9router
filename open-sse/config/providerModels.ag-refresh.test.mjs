/**
 * Guards Antigravity / Claude Code / Gemini CLI model lists stay aligned with
 * current upstream IDs (not legacy gemini-3.1-pro-high-only AG list).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PROVIDER_MODELS, getModelUpstreamId } from "./providerModels.js";
import { PROVIDERS } from "./providers.js";

test("antigravity models include current IDE agent IDs", () => {
  const ids = PROVIDER_MODELS.ag.map((m) => m.id);
  for (const id of [
    "gemini-3-flash-agent",
    "gemini-3.5-flash-low",
    "gemini-3.5-flash-extra-low",
    "gemini-pro-agent",
    "gemini-3.1-pro-low",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
    "gemini-3-flash",
    "gemini-3.1-flash-image",
  ]) {
    assert.ok(ids.includes(id), `missing AG model ${id}`);
  }
});

test("legacy gemini-3.1-pro-high maps to gemini-pro-agent", () => {
  assert.equal(
    getModelUpstreamId("ag", "gemini-3.1-pro-high"),
    "gemini-pro-agent",
  );
});

test("antigravity transport uses IDE 2.1.1 fingerprint host", () => {
  assert.deepEqual(PROVIDERS.antigravity.baseUrls, [
    "https://cloudcode-pa.googleapis.com",
  ]);
  assert.match(
    PROVIDERS.antigravity.headers["User-Agent"],
    /antigravity\/ide\/2\.1\.1/,
  );
});

test("claude code list includes sonnet-5 and opus-4-8", () => {
  const ids = PROVIDER_MODELS.cc.map((m) => m.id);
  assert.ok(ids.includes("claude-sonnet-5"));
  assert.ok(ids.includes("claude-opus-4-8"));
  assert.ok(ids.includes("claude-fable-5"));
});

test("gemini cli list includes 3.1 pro and 2.5 family", () => {
  const ids = PROVIDER_MODELS.gc.map((m) => m.id);
  assert.ok(ids.includes("gemini-3.1-pro-preview"));
  assert.ok(ids.includes("gemini-2.5-flash"));
});
