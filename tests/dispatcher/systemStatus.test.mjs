import test from "node:test";
import assert from "node:assert/strict";
import { getSystemTelemetry } from "../../src/lib/system/statsCollector.js";

test("getSystemTelemetry collects comprehensive host and application telemetry", () => {
  const telemetry = getSystemTelemetry();

  assert.ok(telemetry, "Telemetry object should be returned");
  assert.ok(typeof telemetry.timestamp === "number", "Timestamp should be numeric");

  // Host assertions
  assert.ok(telemetry.host, "Host object should exist");
  assert.ok(typeof telemetry.host.hostname === "string", "Hostname should be a string");
  assert.ok(typeof telemetry.host.platform === "string", "Platform should be a string");
  assert.ok(typeof telemetry.host.uptimeSeconds === "number", "Uptime should be numeric");

  // CPU
  assert.ok(telemetry.host.cpu, "CPU object should exist");
  assert.ok(telemetry.host.cpu.coreCount > 0, "Core count should be positive");
  assert.ok(Array.isArray(telemetry.host.cpu.cores), "Cores should be an array");
  assert.equal(telemetry.host.cpu.cores.length, telemetry.host.cpu.coreCount);
  assert.ok(typeof telemetry.host.cpu.usagePercent === "number", "Host CPU % should be numeric");

  // Host Memory
  assert.ok(telemetry.host.memory, "Host memory should exist");
  assert.ok(telemetry.host.memory.totalBytes > 0, "Total RAM should be positive");
  assert.ok(telemetry.host.memory.freeBytes >= 0, "Free RAM should be non-negative");
  assert.ok(telemetry.host.memory.usedBytes > 0, "Used RAM should be positive");
  assert.ok(telemetry.host.memory.usagePercent >= 0 && telemetry.host.memory.usagePercent <= 100);

  // Application / Process
  assert.ok(telemetry.application, "Application object should exist");
  assert.equal(typeof telemetry.application.pid, "number", "PID should be numeric");
  assert.ok(typeof telemetry.application.uptimeSeconds === "number", "Process uptime should be numeric");
  assert.ok(telemetry.application.nodeVersion.startsWith("v"), "Node version should start with v");

  // Application Memory
  assert.ok(telemetry.application.memory, "App memory should exist");
  assert.ok(telemetry.application.memory.rssBytes > 0, "RSS should be positive");
  assert.ok(telemetry.application.memory.heapUsedBytes > 0, "Heap used should be positive");
  assert.ok(telemetry.application.memory.heapTotalBytes > 0, "Heap total should be positive");
  assert.ok(telemetry.application.memory.heapLimitBytes > 0, "Heap limit should be positive");

  // V8 Heap
  assert.ok(telemetry.application.v8Heap, "V8 heap should exist");
  assert.ok(telemetry.application.v8Heap.totalHeapSize > 0);

  // Event Loop
  assert.ok(telemetry.application.eventLoop, "Event loop metrics should exist");
  assert.ok(typeof telemetry.application.eventLoop.meanMs === "number");

  // Storage
  assert.ok(telemetry.storage, "Storage object should exist");
  assert.ok(typeof telemetry.storage.connected === "boolean");
  assert.ok(typeof telemetry.storage.dbSizeBytes === "number");
  assert.ok(Array.isArray(telemetry.storage.disks), "Disks should be an array");
  assert.ok(telemetry.storage.disks.length > 0, "At least one disk volume should be detected");
  const firstDisk = telemetry.storage.disks[0];
  assert.ok(firstDisk.totalBytes > 0, "Disk total bytes should be positive");
  assert.ok(firstDisk.freeBytes >= 0, "Disk free bytes should be non-negative");
  assert.ok(firstDisk.usagePercent >= 0 && firstDisk.usagePercent <= 100);
});
