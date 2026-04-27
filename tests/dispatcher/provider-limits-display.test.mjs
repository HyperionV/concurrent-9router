import test from "node:test";
import assert from "node:assert/strict";

import { getConnectionDisplayLabel } from "../../src/shared/utils/connectionDisplay.js";

test("uses email instead of generated account labels", () => {
  assert.equal(
    getConnectionDisplayLabel({
      name: "Account 14",
      email: "operator@example.com",
    }),
    "operator@example.com",
  );
});

test("keeps custom connection names ahead of email", () => {
  assert.equal(
    getConnectionDisplayLabel({
      name: "Production Codex",
      email: "operator@example.com",
    }),
    "Production Codex",
  );
});

test("falls back to generated account label when email is unavailable", () => {
  assert.equal(getConnectionDisplayLabel({ name: "Account 14" }), "Account 14");
});
