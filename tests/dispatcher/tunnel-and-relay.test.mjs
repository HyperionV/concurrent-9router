import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

test("Cloudflare Tunnel - WORKER_URL points to abc-tunnel.us and PID ownership is strictly preserved", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-tunnel-test-"));
  process.env.DATA_DIR = tempDir;

  try {
    const { WORKER_URL } = await import("@/lib/tunnel/cloudflare/config.js");
    assert.equal(WORKER_URL, "https://abc-tunnel.us");

    const { savePid, loadPid, clearPid } = await import(
      "@/lib/tunnel/cloudflare/pid.js"
    );

    savePid(1234);
    assert.equal(loadPid(), 1234);

    // Mismatched PID should NOT clear successor PID
    const clearedWrong = clearPid(9999);
    assert.equal(clearedWrong, false);
    assert.equal(loadPid(), 1234);

    // Matching PID clears
    const clearedRight = clearPid(1234);
    assert.equal(clearedRight, true);
    assert.equal(loadPid(), null);
  } finally {
    delete process.env.DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Cloudflare Tunnel - spawnQuickTunnel enforces 127.0.0.1, http2, and --retries 99", async () => {
  const fileContent = fs.readFileSync(
    path.join(process.cwd(), "src/lib/tunnel/cloudflare/cloudflared.js"),
    "utf8",
  );

  assert.match(fileContent, /127\.0\.0\.1:\$\{localPort\}/);
  assert.match(fileContent, /--retries/);
  assert.match(fileContent, /DEFAULT_QUICK_TUNNEL_PROTOCOL = "http2"/);
  assert.match(fileContent, /Get-CimInstance Win32_Process/);
});

test("Edge Relay - resolveConnectionProxyConfig recognizes vercel, cloudflare, and deno relay pools", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-relay-test-"));
  process.env.DATA_DIR = tempDir;

  const { closeSqlite } = await import("@/lib/sqlite/runtime.js");
  closeSqlite();
  const { createProxyPool } = await import("@/models");
  const { resolveConnectionProxyConfig } = await import(
    "@/lib/network/connectionProxy.js"
  );

  try {
    const vercelPool = await createProxyPool({
      name: "Test Vercel Relay",
      proxyUrl: "https://relay-vercel.example.com",
      type: "vercel",
      isActive: true,
    });

    const cloudflarePool = await createProxyPool({
      name: "Test Cloudflare Relay",
      proxyUrl: "https://relay-cf.example.workers.dev",
      type: "cloudflare",
      isActive: true,
    });

    const denoPool = await createProxyPool({
      name: "Test Deno Relay",
      proxyUrl: "https://relay-deno.deno.dev",
      type: "deno",
      isActive: true,
    });

    const vercelCfg = await resolveConnectionProxyConfig({
      proxyPoolId: vercelPool.id,
    });
    assert.equal(vercelCfg.source, "vercel");
    assert.equal(vercelCfg.vercelRelayUrl, "https://relay-vercel.example.com");
    assert.equal(vercelCfg.connectionProxyEnabled, false);

    const cfCfg = await resolveConnectionProxyConfig({
      proxyPoolId: cloudflarePool.id,
    });
    assert.equal(cfCfg.source, "cloudflare");
    assert.equal(cfCfg.vercelRelayUrl, "https://relay-cf.example.workers.dev");
    assert.equal(cfCfg.connectionProxyEnabled, false);

    const denoCfg = await resolveConnectionProxyConfig({
      proxyPoolId: denoPool.id,
    });
    assert.equal(denoCfg.source, "deno");
    assert.equal(denoCfg.vercelRelayUrl, "https://relay-deno.deno.dev");
    assert.equal(denoCfg.connectionProxyEnabled, false);
  } finally {
    closeSqlite();
    delete process.env.DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
