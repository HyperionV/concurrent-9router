import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTypedExportEnvelope,
  normalizeExportType,
  validateTypedImportPayload,
} from "@/lib/sqlite/typedBackup.js";

test("normalizes supported typed export names", () => {
  assert.equal(normalizeExportType("full"), "full");
  assert.equal(normalizeExportType("accounts"), "accounts");
  assert.equal(normalizeExportType("account-list"), "accounts");
  assert.equal(normalizeExportType("usage"), "usage");
  assert.throws(() => normalizeExportType("unknown"), /Unsupported export type/);
});

test("builds typed account export envelope with sensitive marker", () => {
  const envelope = buildTypedExportEnvelope("accounts", {
    providerConnections: [{ id: "conn-1", provider: "codex" }],
  });

  assert.equal(envelope.format, "9router-partial-export");
  assert.equal(envelope.type, "accounts");
  assert.equal(envelope.sensitive, true);
  assert.deepEqual(envelope.data.providerConnections, [
    { id: "conn-1", provider: "codex" },
  ]);
});

test("rejects import payloads whose type does not match the selected import", () => {
  const envelope = buildTypedExportEnvelope("usage", { usageEvents: [] });

  assert.throws(
    () => validateTypedImportPayload(envelope, "accounts"),
    /does not match selected import type/,
  );
});
