"use client";

import { Card, Badge } from "@/shared/components";
import { formatBytes, formatPercent, getStatusColor } from "../utils";

export default function StorageUsageCard({ data }) {
  if (!data?.storage) return null;

  const { storage } = data;
  const disks = storage.disks || [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* 1. Host Storage Drives & Volumes */}
      <Card className="p-5 border-black/5 dark:border-white/5 bg-surface space-y-4">
        <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-amber-500">
              hard_drive
            </span>
            <h4 className="text-sm font-semibold text-text-main">Server Host Disks & Volumes</h4>
          </div>
          <Badge variant="outline">{disks.length} Drives Detected</Badge>
        </div>

        {disks.length === 0 ? (
          <p className="text-xs text-text-muted">No disk volume information available.</p>
        ) : (
          <div className="space-y-3.5">
            {disks.map((disk) => {
              const usage = disk.usagePercent ?? 0;
              const status = getStatusColor(usage);

              return (
                <div
                  key={disk.mount}
                  className="p-3 rounded-lg border border-black/5 dark:border-white/5 bg-black/5 dark:bg-white/5 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-[18px] text-text-muted">
                        album
                      </span>
                      <span className="text-xs font-semibold text-text-main font-mono">
                        {disk.mount}
                      </span>
                    </div>
                    <Badge variant={status.badge}>{formatPercent(usage)}</Badge>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ease-out ${status.bg}`}
                      style={{ width: `${Math.min(100, Math.max(0, usage))}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-text-muted">
                    <span>Used: {formatBytes(disk.usedBytes)}</span>
                    <span>Free: {formatBytes(disk.freeBytes)}</span>
                    <span className="font-semibold text-text-main">Total: {formatBytes(disk.totalBytes)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* 2. Application SQLite Storage & Data Directory */}
      <Card className="p-5 border-black/5 dark:border-white/5 bg-surface space-y-4">
        <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-primary">
              database
            </span>
            <h4 className="text-sm font-semibold text-text-main">Application Storage & SQLite</h4>
          </div>
          <Badge variant={storage.connected ? "success" : "error"}>
            {storage.connected ? "SQLite Active" : "Disconnected"}
          </Badge>
        </div>

        {/* Application storage breakdown cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
            <p className="text-[11px] text-text-muted">Main Database</p>
            <p className="text-sm font-semibold text-text-main mt-0.5 font-mono">
              {formatBytes(storage.dbSizeBytes)}
            </p>
            <span className="text-[10px] text-text-muted">state.sqlite</span>
          </div>
          <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
            <p className="text-[11px] text-text-muted">WAL Journal</p>
            <p className="text-sm font-semibold text-text-main mt-0.5 font-mono">
              {formatBytes(storage.walSizeBytes)}
            </p>
            <span className="text-[10px] text-text-muted">Write-Ahead Log</span>
          </div>
          <div className="p-3 rounded-lg bg-black/5 dark:bg-white/5">
            <p className="text-[11px] text-text-muted">Shared Memory</p>
            <p className="text-sm font-semibold text-text-main mt-0.5 font-mono">
              {formatBytes(storage.shmSizeBytes)}
            </p>
            <span className="text-[10px] text-text-muted">SHM cache</span>
          </div>
        </div>

        {/* Total Footprint Summary */}
        <div className="p-3 rounded-lg border border-primary/20 bg-primary/5 flex items-center justify-between">
          <div>
            <p className="text-xs font-semibold text-text-main">Total Application Storage</p>
            <p className="text-[11px] text-text-muted font-mono truncate" title={storage.dbPath}>
              {storage.dbPath}
            </p>
          </div>
          <span className="text-lg font-bold text-primary font-mono">
            {formatBytes(storage.totalStorageBytes)}
          </span>
        </div>

        {/* Entity density */}
        <div className="pt-2 border-t border-black/5 dark:border-white/5">
          <p className="text-[11px] font-semibold text-text-muted uppercase tracking-wider mb-2">
            Persisted Entities in SQLite
          </p>
          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="p-2 rounded bg-black/5 dark:bg-white/5">
              <span className="text-[10px] text-text-muted uppercase block">Providers</span>
              <span className="text-xs font-bold text-text-main font-mono">
                {storage.counts?.providers ?? 0}
              </span>
            </div>
            <div className="p-2 rounded bg-black/5 dark:bg-white/5">
              <span className="text-[10px] text-text-muted uppercase block">Proxy Pools</span>
              <span className="text-xs font-bold text-text-main font-mono">
                {storage.counts?.proxyPools ?? 0}
              </span>
            </div>
            <div className="p-2 rounded bg-black/5 dark:bg-white/5">
              <span className="text-[10px] text-text-muted uppercase block">API Keys</span>
              <span className="text-xs font-bold text-text-main font-mono">
                {storage.counts?.keys ?? 0}
              </span>
            </div>
            <div className="p-2 rounded bg-black/5 dark:bg-white/5">
              <span className="text-[10px] text-text-muted uppercase block">Combos</span>
              <span className="text-xs font-bold text-text-main font-mono">
                {storage.counts?.combos ?? 0}
              </span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
