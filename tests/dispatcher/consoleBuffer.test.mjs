import test from "node:test";
import assert from "node:assert/strict";
import {
  stripAnsi,
  detectLogLevel,
  parseSinceToMs,
  getConsoleBuffer,
} from "../../src/lib/consoleBuffer.js";

test("stripAnsi removes color and control codes", () => {
  const input = "\x1B[36m[02:22:38] 📥 POST /v1/chat/completions\x1B[0m";
  assert.equal(stripAnsi(input), "[02:22:38] 📥 POST /v1/chat/completions");
});

test("detectLogLevel accurately classifies messages", () => {
  assert.equal(detectLogLevel("[02:22:37] ❌ [TOKEN_REFRESH] Failed"), "ERROR");
  assert.equal(detectLogLevel("Something failed", true), "ERROR");
  assert.equal(detectLogLevel("[02:22:37] ⚠️  [AUTH] Cooldown"), "WARN");
  assert.equal(detectLogLevel("[02:22:37] ℹ️  [DISPATCHER] LEASE_OK"), "DISPATCHER");
  assert.equal(detectLogLevel("[02:22:37] 📥 POST /v1/chat/completions"), "REQUEST");
  assert.equal(detectLogLevel("[02:22:38] 📊 [USAGE] GROK-CLI"), "USAGE");
  assert.equal(detectLogLevel("[02:22:37] 🔍 [FORMAT] openai"), "DEBUG");
  assert.equal(detectLogLevel("Normal operational log"), "INFO");
});

test("parseSinceToMs parses relative strings", () => {
  const now = Date.now();
  const tenMins = parseSinceToMs("10m");
  assert.ok(tenMins !== null);
  assert.ok(Math.abs(now - 600000 - tenMins) < 100);

  const oneHour = parseSinceToMs("1h");
  assert.ok(Math.abs(now - 3600000 - oneHour) < 100);
});

test("ConsoleBuffer pushes lines and retrieves with filters", () => {
  const buffer = getConsoleBuffer();
  buffer.clear();

  buffer.pushLine("[02:00:00] ℹ️  [DISPATCHER] grok: LEASE_OK attempt=1");
  buffer.pushLine("[02:00:01] 📥 POST /v1/chat/completions");
  buffer.pushLine("[02:00:02] ❌ [ERROR] Something broke");

  const all = buffer.getEntries({ tail: 10 });
  assert.equal(all.entries.length, 3);
  assert.equal(all.stats.errors, 1);

  const errors = buffer.getEntries({ level: "ERROR" });
  assert.equal(errors.entries.length, 1);
  assert.equal(errors.entries[0].level, "ERROR");

  const search = buffer.getEntries({ search: "LEASE_OK" });
  assert.equal(search.entries.length, 1);
  assert.equal(search.entries[0].text.includes("LEASE_OK"), true);
});
