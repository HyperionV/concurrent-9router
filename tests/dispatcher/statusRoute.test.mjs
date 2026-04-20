import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("dispatcher status route reads connections from the outer dispatcher wrapper", () => {
  const routeSource = read("src/app/api/dispatcher/status/route.js");

  assert.match(
    routeSource,
    /const\s+\{\s*dispatcher,\s*watchdog,\s*getConnections\s*\}\s*=\s*getCodexDispatcher\(\)/,
  );
  assert.match(
    routeSource,
    /await\s+Promise\.all\(\[\s*getSettings\(\),\s*getConnections\?\.\(\)\s*\|\|\s*\[\]/s,
  );
  assert.doesNotMatch(routeSource, /dispatcher\?\.getConnections\?\.\(\)/);
});
