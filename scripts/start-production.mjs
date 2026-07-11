/**
 * Production start for Next.js `output: "standalone"`.
 * `next start` is unsupported in standalone mode and can serve a broken/stale graph.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneDir = path.join(root, ".next", "standalone");
const serverPath = path.join(standaloneDir, "server.js");

if (!fs.existsSync(serverPath)) {
  console.error(
    "[start] Missing .next/standalone/server.js — run `npm run build` first.",
  );
  process.exit(1);
}

function copyIfMissing(src, dest) {
  if (!fs.existsSync(src)) return;
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log(`[start] copied ${path.relative(root, src)} → standalone`);
}

// Standalone server needs static + public next to server.js
copyIfMissing(
  path.join(root, ".next", "static"),
  path.join(standaloneDir, ".next", "static"),
);
copyIfMissing(path.join(root, "public"), path.join(standaloneDir, "public"));

const env = {
  ...process.env,
  PORT: process.env.PORT || "20128",
  HOSTNAME: process.env.HOSTNAME || "0.0.0.0",
};

// Keep DATA_DIR / project-relative paths resolved from repo root, not standalone cwd.
const child = spawn(process.execPath, [serverPath], {
  stdio: "inherit",
  env,
  cwd: root,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
