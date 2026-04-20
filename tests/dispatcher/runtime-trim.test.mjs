import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("root layout does not initialize console log capture", () => {
  const layout = read("src/app/layout.js");
  assert.equal(layout.includes("consoleLogBuffer"), false);
  assert.equal(layout.includes("initConsoleLogCapture"), false);
});

test("sidebar does not fetch version metadata or expose console log page", () => {
  const sidebar = read("src/shared/components/Sidebar.js");
  assert.equal(sidebar.includes("/api/version"), false);
  assert.equal(sidebar.includes("/dashboard/console-log"), false);
});
