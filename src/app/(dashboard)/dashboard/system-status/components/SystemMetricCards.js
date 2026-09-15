"use client";

import { Card, Badge } from "@/shared/components";
import { formatBytes, formatPercent, getStatusColor } from "../utils";

export default function SystemMetricCards({ data }) {
  if (!data) return null;

  const { host, application, storage } = data;
  const hostCpu = host?.cpu?.usagePercent ?? 0;
  const hostCpuColor = getStatusColor(hostCpu);

  const hostMemPercent = host?.memory?.usagePercent ?? 0;
  const hostMemColor = getStatusColor(hostMemPercent);

  const primaryDisk = storage?.disks?.[0];
  const diskUsage = primaryDisk?.usagePercent ?? 0;
  const diskColor = getStatusColor(diskUsage);

  const rss = application?.memory?.rssBytes ?? 0;
  const heapUsed = application?.memory?.heapUsedBytes ?? 0;
  const heapTotal = application?.memory?.heapTotalBytes ?? 0;
  const heapLimit = application?.memory?.heapLimitBytes ?? 1;
  const heapPercent = Math.round((heapUsed / heapLimit) * 1000) / 10;
  const appMemColor = getStatusColor(heapPercent);

  const meanLag = application?.eventLoop?.meanMs ?? 0;
  const p99Lag = application?.eventLoop?.p99Ms ?? 0;
  const lagStatus = meanLag > 50 ? "error" : meanLag > 15 ? "warning" : "success";

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
      {/* 1. Host CPU */}
      <Card className="p-5 flex flex-col justify-between border-black/5 dark:border-white/5 bg-surface hover:shadow-md transition-shadow">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <span className="material-symbols-outlined text-[20px]">speed</span>
            </div>
            <div>
              <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Host CPU</p>
              <p className="text-xs text-text-muted">{host?.cpu?.coreCount ?? 1} Cores</p>
            </div>
          </div>
          <Badge variant={hostCpuColor.badge}>{formatPercent(hostCpu)}</Badge>
        </div>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tracking-tight text-text-main">
              {formatPercent(hostCpu)}
            </span>
            <span className="text-xs text-text-muted">
              App: {formatPercent(application?.cpu?.usagePercent ?? 0)}
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${hostCpuColor.bg}`}
              style={{ width: `${Math.min(100, Math.max(0, hostCpu))}%` }}
            />
          </div>
          <p className="text-[11px] text-text-muted truncate" title={host?.cpu?.model}>
            {host?.cpu?.model || "Standard CPU"}
          </p>
        </div>
      </Card>

      {/* 2. Host Memory */}
      <Card className="p-5 flex flex-col justify-between border-black/5 dark:border-white/5 bg-surface hover:shadow-md transition-shadow">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-blue-500/10 text-blue-500">
              <span className="material-symbols-outlined text-[20px]">memory</span>
            </div>
            <div>
              <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Host RAM</p>
              <p className="text-xs text-text-muted">{formatBytes(host?.memory?.totalBytes)}</p>
            </div>
          </div>
          <Badge variant={hostMemColor.badge}>{formatPercent(hostMemPercent)}</Badge>
        </div>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tracking-tight text-text-main">
              {formatBytes(host?.memory?.usedBytes)}
            </span>
            <span className="text-xs text-text-muted">
              Free: {formatBytes(host?.memory?.freeBytes)}
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${hostMemColor.bg}`}
              style={{ width: `${Math.min(100, Math.max(0, hostMemPercent))}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-text-muted">
            <span>Used: {formatPercent(hostMemPercent)}</span>
            <span>{formatBytes(host?.memory?.freeBytes)} free</span>
          </div>
        </div>
      </Card>

      {/* 3. Disk Storage */}
      <Card className="p-5 flex flex-col justify-between border-black/5 dark:border-white/5 bg-surface hover:shadow-md transition-shadow">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-amber-500/10 text-amber-500">
              <span className="material-symbols-outlined text-[20px]">hard_drive</span>
            </div>
            <div>
              <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Disk Storage</p>
              <p className="text-xs text-text-muted font-mono">{primaryDisk?.mount || "Root"}</p>
            </div>
          </div>
          <Badge variant={diskColor.badge}>{formatPercent(diskUsage)}</Badge>
        </div>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tracking-tight text-text-main">
              {formatBytes(primaryDisk?.usedBytes)}
            </span>
            <span className="text-xs text-text-muted">
              Free: {formatBytes(primaryDisk?.freeBytes)}
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${diskColor.bg}`}
              style={{ width: `${Math.min(100, Math.max(0, diskUsage))}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-text-muted">
            <span>Total: {formatBytes(primaryDisk?.totalBytes)}</span>
            <span>SQLite: {formatBytes(storage?.totalStorageBytes)}</span>
          </div>
        </div>
      </Card>

      {/* 4. Node Process Memory */}
      <Card className="p-5 flex flex-col justify-between border-black/5 dark:border-white/5 bg-surface hover:shadow-md transition-shadow">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-purple-500/10 text-purple-500">
              <span className="material-symbols-outlined text-[20px]">layers</span>
            </div>
            <div>
              <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">App RSS</p>
              <p className="text-xs text-text-muted">PID {application?.pid}</p>
            </div>
          </div>
          <Badge variant={appMemColor.badge}>{formatPercent(heapPercent)} Limit</Badge>
        </div>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tracking-tight text-text-main">
              {formatBytes(rss)}
            </span>
            <span className="text-xs text-text-muted">
              Heap: {formatBytes(heapUsed)}
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${appMemColor.bg}`}
              style={{ width: `${Math.min(100, Math.max(0, heapPercent))}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-text-muted">
            <span>Allocated: {formatBytes(heapTotal)}</span>
            <span>Limit: {formatBytes(heapLimit)}</span>
          </div>
        </div>
      </Card>

      {/* 5. Event Loop & Handles */}
      <Card className="p-5 flex flex-col justify-between border-black/5 dark:border-white/5 bg-surface hover:shadow-md transition-shadow">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-500">
              <span className="material-symbols-outlined text-[20px]">pulse_alert</span>
            </div>
            <div>
              <p className="text-xs font-semibold text-text-muted uppercase tracking-wider">Event Loop</p>
              <p className="text-xs text-text-muted">Lag Latency</p>
            </div>
          </div>
          <Badge variant={lagStatus}>{meanLag} ms</Badge>
        </div>
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <span className="text-2xl font-bold tracking-tight text-text-main">
              {meanLag} <span className="text-sm font-normal text-text-muted">ms</span>
            </span>
            <span className="text-xs text-text-muted">
              p99: {p99Lag} ms
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-black/5 dark:bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ease-out ${
                meanLag > 50 ? "bg-rose-500" : meanLag > 15 ? "bg-amber-500" : "bg-emerald-500"
              }`}
              style={{ width: `${Math.min(100, Math.max(2, (meanLag / 50) * 100))}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-text-muted">
            <span>Handles: {application?.handlesAndRequests?.activeHandles ?? 0}</span>
            <span>Async: {application?.handlesAndRequests?.activeRequests ?? 0}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}
