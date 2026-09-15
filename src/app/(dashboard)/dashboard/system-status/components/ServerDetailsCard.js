"use client";

import { Card, Badge } from "@/shared/components";
import { formatBytes, formatDuration, formatPercent, getStatusColor } from "../utils";

export default function ServerDetailsCard({ data }) {
  if (!data?.host) return null;

  const { host, storage } = data;
  const cores = host.cpu?.cores || [];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* 1. Per-Core CPU Activity Grid */}
      <Card className="p-5 border-black/5 dark:border-white/5 bg-surface space-y-4">
        <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-primary">
              developer_board
            </span>
            <h4 className="text-sm font-semibold text-text-main">CPU Cores Multi-Threading</h4>
          </div>
          <Badge variant="outline">{cores.length} Logical Cores</Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5 max-h-[300px] overflow-y-auto custom-scrollbar pr-1">
          {cores.map((core) => {
            const usage = core.usagePercent ?? 0;
            const status = getStatusColor(usage);
            return (
              <div
                key={core.core}
                className="p-2.5 rounded-lg border border-black/5 dark:border-white/5 bg-black/5 dark:bg-white/5 flex flex-col justify-between gap-1.5"
              >
                <div className="flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-text-muted">Core {core.core}</span>
                  <span className={`font-mono font-bold ${status.text}`}>
                    {formatPercent(usage)}
                  </span>
                </div>
                <div className="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${status.bg}`}
                    style={{ width: `${Math.min(100, Math.max(0, usage))}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-text-muted">
                  <span>{core.speedMhz ? `${core.speedMhz} MHz` : "Auto"}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Load Averages if available */}
        {host.cpu?.loadavg && host.cpu.loadavg.some((v) => v > 0) && (
          <div className="pt-2 border-t border-black/5 dark:border-white/5 flex items-center justify-between text-xs">
            <span className="text-text-muted">Load Average (1m, 5m, 15m):</span>
            <span className="font-mono text-text-main font-semibold">
              {host.cpu.loadavg.map((v) => v.toFixed(2)).join(", ")}
            </span>
          </div>
        )}
      </Card>

      {/* 2. Host OS & Hardware Details */}
      <Card className="p-5 border-black/5 dark:border-white/5 bg-surface space-y-4">
        <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[20px] text-blue-500">
              dns
            </span>
            <h4 className="text-sm font-semibold text-text-main">Host System & Environment</h4>
          </div>
          <Badge variant="success">Operational</Badge>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
          <div>
            <span className="text-text-muted block">Hostname</span>
            <span className="font-semibold text-text-main truncate block" title={host.hostname}>
              {host.hostname}
            </span>
          </div>
          <div>
            <span className="text-text-muted block">OS Platform</span>
            <span className="font-semibold text-text-main uppercase">{host.platform} ({host.arch})</span>
          </div>
          <div>
            <span className="text-text-muted block">Kernel / Release</span>
            <span className="font-mono text-text-main truncate block" title={host.release}>
              {host.release}
            </span>
          </div>
          <div>
            <span className="text-text-muted block">Host Uptime</span>
            <span className="font-semibold text-text-main">
              {formatDuration(host.uptimeSeconds)}
            </span>
          </div>
          <div>
            <span className="text-text-muted block">Byte Order</span>
            <span className="font-mono text-text-main">{host.endianness} Endian</span>
          </div>
          <div>
            <span className="text-text-muted block">Total RAM</span>
            <span className="font-semibold text-text-main">{formatBytes(host.memory?.totalBytes)}</span>
          </div>
        </div>

        {/* Storage & Database Health */}
        {storage && (
          <div className="pt-3 border-t border-black/5 dark:border-white/5 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                SQLite Storage & Entities
              </span>
              <Badge variant={storage.connected ? "success" : "error"}>
                {storage.connected ? "SQLite Connected" : "Disconnected"}
              </Badge>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
              <div className="p-2 rounded bg-black/5 dark:bg-white/5">
                <span className="text-[10px] text-text-muted uppercase block">Main DB</span>
                <span className="text-xs font-bold text-text-main font-mono">
                  {formatBytes(storage.dbSizeBytes)}
                </span>
              </div>
              <div className="p-2 rounded bg-black/5 dark:bg-white/5">
                <span className="text-[10px] text-text-muted uppercase block">WAL Journal</span>
                <span className="text-xs font-bold text-text-main font-mono">
                  {formatBytes(storage.walSizeBytes)}
                </span>
              </div>
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
            </div>
            <p className="text-[11px] font-mono text-text-muted truncate" title={storage.dbPath}>
              Path: {storage.dbPath}
            </p>
          </div>
        )}
      </Card>

      {/* 3. Active Network Adapters */}
      {host.network && host.network.length > 0 && (
        <Card className="p-5 border-black/5 dark:border-white/5 bg-surface space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between border-b border-black/5 dark:border-white/5 pb-2">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px] text-emerald-500">
                lan
              </span>
              <h4 className="text-sm font-semibold text-text-main">Network Interfaces</h4>
            </div>
            <Badge variant="outline">{host.network.length} Addresses</Badge>
          </div>

          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-black/5 dark:border-white/5 text-text-muted uppercase text-[10px]">
                  <th className="py-2 px-3">Interface</th>
                  <th className="py-2 px-3">Family</th>
                  <th className="py-2 px-3">IP Address</th>
                  <th className="py-2 px-3">Netmask</th>
                  <th className="py-2 px-3">MAC Address</th>
                  <th className="py-2 px-3">Type</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/5 dark:divide-white/5 font-mono">
                {host.network.map((net, i) => (
                  <tr key={`${net.interface}-${net.address}-${i}`} className="hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                    <td className="py-2 px-3 font-semibold text-text-main">{net.interface}</td>
                    <td className="py-2 px-3">
                      <span className="px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 text-[10px]">
                        {net.family}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-text-main">{net.address}</td>
                    <td className="py-2 px-3 text-text-muted">{net.netmask || "--"}</td>
                    <td className="py-2 px-3 text-text-muted">{net.mac || "--"}</td>
                    <td className="py-2 px-3">
                      <Badge variant={net.internal ? "default" : "success"}>
                        {net.internal ? "Internal / Loopback" : "External / LAN"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
