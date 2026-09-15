import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { DATA_DIR } from "@/lib/dataDir.js";
import { getSqlite, getSqlitePath } from "@/lib/sqlite/runtime.js";

// Event loop delay monitor with 20ms resolution
let eventLoopHistogram = null;
try {
  eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
  eventLoopHistogram.enable();
} catch {
  eventLoopHistogram = null;
}

// Module-level cache for differential calculations (CPU usage)
let lastSampleTime = Date.now();
let lastCpus = os.cpus();
let lastProcessCpu = process.cpuUsage();

function calculateCpuDiff() {
  const currentCpus = os.cpus();
  const currentProcessCpu = process.cpuUsage();
  const currentTime = Date.now();
  const elapsedMs = Math.max(1, currentTime - lastSampleTime);

  let totalDiff = 0;
  let idleDiff = 0;
  const cores = [];

  for (let i = 0; i < currentCpus.length; i++) {
    const current = currentCpus[i].times;
    const last = lastCpus[i] ? lastCpus[i].times : current;

    const currentTotal = current.user + current.nice + current.sys + current.idle + current.irq;
    const lastTotal = last.user + last.nice + last.sys + last.idle + last.irq;
    const coreTotalDiff = Math.max(0, currentTotal - lastTotal);
    const coreIdleDiff = Math.max(0, current.idle - last.idle);

    totalDiff += coreTotalDiff;
    idleDiff += coreIdleDiff;

    const coreUsagePct =
      coreTotalDiff > 0
        ? Math.max(0, Math.min(100, Math.round(((coreTotalDiff - coreIdleDiff) / coreTotalDiff) * 1000) / 10))
        : 0;

    cores.push({
      core: i,
      model: currentCpus[i].model,
      speedMhz: currentCpus[i].speed,
      usagePercent: coreUsagePct,
      times: current,
    });
  }

  const hostCpuPercent =
    totalDiff > 0
      ? Math.max(0, Math.min(100, Math.round(((totalDiff - idleDiff) / totalDiff) * 1000) / 10))
      : 0;

  // Process CPU delta
  const processCpuDiff = {
    user: Math.max(0, currentProcessCpu.user - lastProcessCpu.user),
    system: Math.max(0, currentProcessCpu.system - lastProcessCpu.system),
  };
  const totalProcessMicros = processCpuDiff.user + processCpuDiff.system;
  const totalAvailableMicros = elapsedMs * 1000 * Math.max(1, currentCpus.length);
  const processCpuPercent = Math.max(
    0,
    Math.min(100, Math.round((totalProcessMicros / totalAvailableMicros) * 1000) / 10)
  );

  // Update stored last values
  lastSampleTime = currentTime;
  lastCpus = currentCpus;
  lastProcessCpu = currentProcessCpu;

  return {
    hostCpuPercent,
    processCpuPercent,
    cores,
    processCpuTimes: {
      userMicros: currentProcessCpu.user,
      systemMicros: currentProcessCpu.system,
      userSeconds: Math.round((currentProcessCpu.user / 1e6) * 100) / 100,
      systemSeconds: Math.round((currentProcessCpu.system / 1e6) * 100) / 100,
    },
  };
}

function getEventLoopMetrics() {
  if (!eventLoopHistogram) {
    return {
      meanMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      minMs: 0,
    };
  }

  const toMs = (ns) => {
    if (!Number.isFinite(ns) || ns <= 0 || ns >= 1e11) return 0;
    return Math.round((ns / 1e6) * 100) / 100;
  };

  return {
    meanMs: toMs(eventLoopHistogram.mean),
    p50Ms: toMs(eventLoopHistogram.percentile(50)),
    p90Ms: toMs(eventLoopHistogram.percentile(90)),
    p95Ms: toMs(eventLoopHistogram.percentile(95)),
    p99Ms: toMs(eventLoopHistogram.percentile(99)),
    maxMs: toMs(eventLoopHistogram.max),
    minMs: toMs(eventLoopHistogram.min),
  };
}

function getDiskDrives() {
  const drives = [];
  if (process.platform === "win32") {
    for (let i = 65; i <= 90; i++) {
      const driveLetter = String.fromCharCode(i) + ":\\";
      try {
        if (fs.existsSync(driveLetter)) {
          const stats = fs.statfsSync(driveLetter);
          const total = stats.blocks * stats.bsize;
          const free = stats.bavail * stats.bsize;
          const used = Math.max(0, total - free);
          if (total > 0) {
            drives.push({
              mount: driveLetter,
              totalBytes: total,
              freeBytes: free,
              usedBytes: used,
              usagePercent: Math.round((used / total) * 1000) / 10,
            });
          }
        }
      } catch {}
    }
  } else {
    const checkPaths = ["/", DATA_DIR];
    const seen = new Set();
    for (const p of checkPaths) {
      try {
        if (fs.existsSync(p)) {
          const stats = fs.statfsSync(p);
          const total = stats.blocks * stats.bsize;
          const free = stats.bavail * stats.bsize;
          const used = Math.max(0, total - free);
          const key = `${total}-${free}`;
          if (total > 0 && !seen.has(key)) {
            seen.add(key);
            drives.push({
              mount: p,
              totalBytes: total,
              freeBytes: free,
              usedBytes: used,
              usagePercent: Math.round((used / total) * 1000) / 10,
            });
          }
        }
      } catch {}
    }
  }
  return drives;
}

function getStorageAndDbStats() {
  let dbSizeBytes = 0;
  let walSizeBytes = 0;
  let shmSizeBytes = 0;
  let connected = false;
  let counts = { providers: 0, proxyPools: 0, keys: 0, combos: 0 };
  const dbPath = getSqlitePath();

  try {
    if (fs.existsSync(dbPath)) {
      dbSizeBytes = fs.statSync(dbPath).size;
    }
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) {
      walSizeBytes = fs.statSync(walPath).size;
    }
    const shmPath = `${dbPath}-shm`;
    if (fs.existsSync(shmPath)) {
      shmSizeBytes = fs.statSync(shmPath).size;
    }

    const db = getSqlite();
    if (db) {
      connected = true;
      try {
        counts.providers = db.prepare("SELECT COUNT(*) as c FROM providers").get()?.c || 0;
      } catch {}
      try {
        counts.proxyPools = db.prepare("SELECT COUNT(*) as c FROM proxy_pools").get()?.c || 0;
      } catch {}
      try {
        counts.keys = db.prepare("SELECT COUNT(*) as c FROM keys").get()?.c || 0;
      } catch {}
      try {
        counts.combos = db.prepare("SELECT COUNT(*) as c FROM combos").get()?.c || 0;
      } catch {}
    }
  } catch {
    connected = false;
  }

  const disks = getDiskDrives();

  return {
    dbPath,
    dataDir: DATA_DIR,
    dbSizeBytes,
    walSizeBytes,
    shmSizeBytes,
    totalStorageBytes: dbSizeBytes + walSizeBytes + shmSizeBytes,
    connected,
    counts,
    disks,
  };
}

function getNetworkInfo() {
  const interfaces = os.networkInterfaces();
  const list = [];

  for (const [name, infos] of Object.entries(interfaces)) {
    if (!infos) continue;
    for (const info of infos) {
      list.push({
        interface: name,
        family: info.family,
        address: info.address,
        netmask: info.netmask,
        mac: info.mac,
        internal: info.internal,
        cidr: info.cidr || null,
      });
    }
  }
  return list;
}

export function getSystemTelemetry() {
  const cpuData = calculateCpuDiff();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memUsagePercent = Math.round((usedMem / totalMem) * 1000) / 10;

  const memUsage = process.memoryUsage();
  const heapStats = v8.getHeapStatistics();
  const eventLoop = getEventLoopMetrics();
  const storage = getStorageAndDbStats();
  const network = getNetworkInfo();

  let resourceUsage = null;
  try {
    if (typeof process.resourceUsage === "function") {
      resourceUsage = process.resourceUsage();
    }
  } catch {}

  const activeHandles = typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : 0;
  const activeRequests = typeof process._getActiveRequests === "function" ? process._getActiveRequests().length : 0;

  return {
    timestamp: Date.now(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      type: os.type(),
      arch: os.arch(),
      release: os.release(),
      uptimeSeconds: Math.round(os.uptime()),
      endianness: os.endianness(),
      cpu: {
        model: cpuData.cores[0]?.model || "Unknown",
        speedMhz: cpuData.cores[0]?.speedMhz || 0,
        coreCount: cpuData.cores.length,
        usagePercent: cpuData.hostCpuPercent,
        loadavg: os.loadavg(),
        cores: cpuData.cores,
      },
      memory: {
        totalBytes: totalMem,
        freeBytes: freeMem,
        usedBytes: usedMem,
        usagePercent: memUsagePercent,
      },
      network,
    },
    application: {
      pid: process.pid,
      ppid: process.ppid || null,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      versions: process.versions,
      cpu: {
        usagePercent: cpuData.processCpuPercent,
        ...cpuData.processCpuTimes,
      },
      memory: {
        rssBytes: memUsage.rss,
        heapTotalBytes: memUsage.heapTotal,
        heapUsedBytes: memUsage.heapUsed,
        heapLimitBytes: heapStats.heap_size_limit,
        heapAvailableBytes: Math.max(0, heapStats.heap_size_limit - memUsage.heapUsed),
        externalBytes: memUsage.external,
        arrayBuffersBytes: memUsage.arrayBuffers || 0,
        heapUsagePercent: Math.round((memUsage.heapUsed / memUsage.heapTotal) * 1000) / 10,
      },
      v8Heap: {
        totalHeapSize: heapStats.total_heap_size,
        totalPhysicalSize: heapStats.total_physical_size,
        totalAvailableSize: heapStats.total_available_size,
        usedHeapSize: heapStats.used_heap_size,
        heapSizeLimit: heapStats.heap_size_limit,
        mallocedMemory: heapStats.malloced_memory,
        peakMallocedMemory: heapStats.peak_malloced_memory,
        nativeContexts: heapStats.number_of_native_contexts,
        detachedContexts: heapStats.number_of_detached_contexts,
      },
      eventLoop,
      handlesAndRequests: {
        activeHandles,
        activeRequests,
      },
      resourceUsage,
    },
    storage,
  };
}
