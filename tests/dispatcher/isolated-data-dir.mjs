// Preloaded before every test file: give each test process its own throwaway
// data directory, so no test can write to the developer's real router database
// or lock the database another test file is using.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-data-"));
}
