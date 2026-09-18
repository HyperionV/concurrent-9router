"use client";

import { Search, X, Play, Pause, RefreshCw, Download, Copy, Trash2, ArrowDown, WrapText } from "lucide-react";

const PRESETS = [
  { label: "Last 200", mode: "snapshot", tail: "200", since: "" },
  { label: "Last 1000", mode: "snapshot", tail: "1000", since: "" },
  { label: "Last 10m", mode: "snapshot", tail: "1000", since: "10m" },
  { label: "Live Stream", mode: "stream", tail: "200", since: "" },
];

const LOG_LEVELS = [
  { id: "ALL", label: "ALL", color: "text-text-main" },
  { id: "ERROR", label: "ERROR", color: "text-red-400 bg-red-500/10 border-red-500/30" },
  { id: "WARN", label: "WARN", color: "text-amber-400 bg-amber-500/10 border-amber-500/30" },
  { id: "DISPATCHER", label: "DISPATCHER", color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/30" },
  { id: "REQUEST", label: "REQUEST", color: "text-sky-400 bg-sky-500/10 border-sky-500/30" },
  { id: "USAGE", label: "USAGE", color: "text-purple-400 bg-purple-500/10 border-purple-500/30" },
  { id: "DEBUG", label: "DEBUG", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/30" },
];

export default function LogToolbar({
  mode,
  setMode,
  tail,
  setTail,
  since,
  setSince,
  selectedLevel,
  setSelectedLevel,
  search,
  setSearch,
  isRegex,
  setIsRegex,
  isCaseSensitive,
  setIsCaseSensitive,
  autoScroll,
  setAutoScroll,
  wrapLines,
  setWrapLines,
  showTimestamps,
  setShowTimestamps,
  streaming,
  loading,
  onRefresh,
  onClearLogs,
  onExport,
  onCopyAll,
  stats,
}) {
  const handlePreset = (preset) => {
    setMode(preset.mode);
    setTail(preset.tail);
    setSince(preset.since);
  };

  return (
    <div className="shrink-0 flex flex-col gap-2 p-3 rounded-xl bg-surface border border-border">
      {/* Top row: Presets & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left: Mode toggle & Presets */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-lg border border-border bg-bg-subtle p-0.5">
            <button
              onClick={() => setMode("stream")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                mode === "stream"
                  ? "bg-primary text-white shadow-xs"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              {streaming ? (
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
                </span>
              ) : (
                <Play className="size-3.5" />
              )}
              Live Stream
            </button>
            <button
              onClick={() => setMode("snapshot")}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                mode === "snapshot"
                  ? "bg-surface text-text-main shadow-xs border border-border"
                  : "text-text-muted hover:text-text-main"
              }`}
            >
              <Pause className="size-3.5" />
              Snapshot
            </button>
          </div>

          <div className="h-4 w-px bg-border mx-1" />

          {/* Quick presets */}
          <div className="flex items-center gap-1">
            {PRESETS.map((p) => {
              const active =
                mode === p.mode && tail === p.tail && since === p.since;
              return (
                <button
                  key={p.label}
                  onClick={() => handlePreset(p)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    active
                      ? "bg-primary/15 text-primary font-medium border border-primary/30"
                      : "bg-bg-subtle text-text-muted hover:text-text-main hover:bg-surface border border-border/50"
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {mode === "snapshot" && (
            <button
              onClick={onRefresh}
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border bg-bg-subtle hover:bg-surface text-text-main transition-colors disabled:opacity-50"
              title="Refresh snapshot"
            >
              <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
          )}

          <button
            onClick={onCopyAll}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border bg-bg-subtle hover:bg-surface text-text-main transition-colors"
            title="Copy visible lines to clipboard"
          >
            <Copy className="size-3.5" />
            Copy
          </button>

          <button
            onClick={onExport}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border bg-bg-subtle hover:bg-surface text-text-main transition-colors"
            title="Download logs file"
          >
            <Download className="size-3.5" />
            Export
          </button>

          <button
            onClick={onClearLogs}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border bg-bg-subtle hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 text-text-muted transition-colors"
            title="Clear buffer"
          >
            <Trash2 className="size-3.5" />
            Clear
          </button>
        </div>
      </div>

      {/* Middle row: Search & Filters */}
      <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-border/60">
        {/* Search bar */}
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-text-muted pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search logs (grep, error code, request id)..."
            className="w-full pl-8 pr-16 py-1.5 text-xs rounded-lg border border-border bg-bg-subtle text-text-main placeholder:text-text-muted/60 focus:outline-none focus:border-primary/60 font-mono"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {search && (
              <button
                onClick={() => setSearch("")}
                className="text-text-muted hover:text-text-main p-0.5"
                title="Clear search"
              >
                <X className="size-3" />
              </button>
            )}
            <button
              onClick={() => setIsRegex((prev) => !prev)}
              className={`px-1 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                isRegex
                  ? "bg-primary text-white border-primary"
                  : "bg-surface text-text-muted border-border hover:text-text-main"
              }`}
              title="Toggle Regex match"
            >
              .*
            </button>
            <button
              onClick={() => setIsCaseSensitive((prev) => !prev)}
              className={`px-1 py-0.5 text-[10px] font-mono rounded border transition-colors ${
                isCaseSensitive
                  ? "bg-primary text-white border-primary"
                  : "bg-surface text-text-muted border-border hover:text-text-main"
              }`}
              title="Toggle Case Sensitivity"
            >
              Aa
            </button>
          </div>
        </div>

        {/* Tail input */}
        <div className="flex items-center gap-1 text-xs text-text-muted">
          <span>Tail:</span>
          <input
            type="number"
            value={tail}
            onChange={(e) => setTail(e.target.value)}
            min="10"
            max="2000"
            className="w-16 px-2 py-1 text-xs rounded border border-border bg-bg-subtle text-text-main font-mono text-center focus:outline-none focus:border-primary"
          />
        </div>

        {/* Since input (for snapshot mode) */}
        {mode === "snapshot" && (
          <div className="flex items-center gap-1 text-xs text-text-muted">
            <span>Since:</span>
            <input
              type="text"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              placeholder="10m, 1h"
              className="w-20 px-2 py-1 text-xs rounded border border-border bg-bg-subtle text-text-main font-mono text-center focus:outline-none focus:border-primary"
            />
          </div>
        )}

        {/* View toggles */}
        <div className="flex items-center gap-1.5 ml-auto">
          <button
            onClick={() => setAutoScroll((prev) => !prev)}
            className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-colors ${
              autoScroll
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                : "bg-bg-subtle text-text-muted border-border hover:text-text-main"
            }`}
            title="Auto-scroll on new log entries"
          >
            <ArrowDown className="size-3" />
            Auto-scroll
          </button>

          <button
            onClick={() => setWrapLines((prev) => !prev)}
            className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-colors ${
              wrapLines
                ? "bg-primary/15 text-primary border-primary/30"
                : "bg-bg-subtle text-text-muted border-border hover:text-text-main"
            }`}
            title="Toggle word wrapping"
          >
            <WrapText className="size-3" />
            Wrap
          </button>

          <button
            onClick={() => setShowTimestamps((prev) => !prev)}
            className={`px-2.5 py-1 text-xs rounded-md border transition-colors ${
              showTimestamps
                ? "bg-surface text-text-main border-border"
                : "bg-bg-subtle text-text-muted border-border/50 hover:text-text-main"
            }`}
            title="Toggle timestamps in log lines"
          >
            Time
          </button>
        </div>
      </div>

      {/* Bottom row: Log Level Filter Chips & Buffer Stats */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-border/60">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-semibold text-text-muted/70 uppercase tracking-wider mr-1">
            Level:
          </span>
          {LOG_LEVELS.map((lvl) => {
            const active = selectedLevel === lvl.id;
            return (
              <button
                key={lvl.id}
                onClick={() => setSelectedLevel(lvl.id)}
                className={`px-2 py-0.5 text-[11px] font-medium rounded-md border transition-all ${
                  active
                    ? "bg-primary text-white border-primary shadow-xs"
                    : "bg-bg-subtle text-text-muted hover:text-text-main border-border hover:bg-surface"
                }`}
              >
                {lvl.label}
              </button>
            );
          })}
        </div>

        {/* Stats strip */}
        {stats && (
          <div className="flex items-center gap-3 text-[11px] text-text-muted font-mono">
            <span>Total: <strong className="text-text-main">{stats.total ?? 0}</strong></span>
            {stats.errors > 0 && (
              <span className="text-red-400">Errors: <strong>{stats.errors}</strong></span>
            )}
            {stats.warnings > 0 && (
              <span className="text-amber-400">Warnings: <strong>{stats.warnings}</strong></span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
