"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import LogToolbar from "./components/LogToolbar";
import LogTerminal from "./components/LogTerminal";

const MAX_CLIENT_LINES = 5000;

export default function ConsoleLogsPage() {
  const [mode, setMode] = useState("stream");
  const [tail, setTail] = useState("200");
  const [since, setSince] = useState("");
  const [selectedLevel, setSelectedLevel] = useState("ALL");
  const [search, setSearch] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [isCaseSensitive, setIsCaseSensitive] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [wrapLines, setWrapLines] = useState(false);
  const [showTimestamps, setShowTimestamps] = useState(true);

  const [entries, setEntries] = useState([]);
  const [stats, setStats] = useState({ total: 0, errors: 0, warnings: 0 });
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState(false);

  const eventSourceRef = useRef(null);

  const stopStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setStreaming(false);
  }, []);

  const fetchSnapshot = useCallback(async () => {
    stopStream();
    setLoading(true);
    try {
      const params = new URLSearchParams({
        tail,
        level: selectedLevel,
        search,
        regex: String(isRegex),
        caseSensitive: String(isCaseSensitive),
      });
      if (since) params.set("since", since);

      const res = await fetch(`/api/console-logs?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setEntries(json.entries || []);
        setStats(json.stats || { total: 0, errors: 0, warnings: 0 });
      }
    } catch (err) {
      console.error("Failed to fetch snapshot logs:", err);
    } finally {
      setLoading(false);
    }
  }, [tail, since, selectedLevel, search, isRegex, isCaseSensitive, stopStream]);

  const startStream = useCallback(() => {
    stopStream();
    setLoading(true);

    const params = new URLSearchParams({
      tail,
      level: selectedLevel,
      search,
      regex: String(isRegex),
      caseSensitive: String(isCaseSensitive),
    });

    const es = new EventSource(`/api/console-logs/stream?${params.toString()}`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setStreaming(true);
      setLoading(false);
    };

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "init") {
          setEntries(data.entries || []);
          if (data.stats) setStats(data.stats);
          setLoading(false);
        } else if (data.type === "log") {
          setEntries((prev) => {
            const next = [...prev, data.entry];
            return next.length > MAX_CLIENT_LINES ? next.slice(-MAX_CLIENT_LINES) : next;
          });
          if (data.stats) setStats(data.stats);
        } else if (data.type === "clear") {
          setEntries([]);
          if (data.stats) setStats(data.stats);
        }
      } catch (err) {
        console.error("Error parsing SSE log event:", err);
      }
    };

    es.onerror = () => {
      setStreaming(false);
      setLoading(false);
    };
  }, [tail, selectedLevel, search, isRegex, isCaseSensitive, stopStream]);

  // Mode or filter triggers stream / snapshot change
  useEffect(() => {
    if (mode === "stream") {
      startStream();
    } else {
      fetchSnapshot();
    }
    return () => {
      stopStream();
    };
  }, [mode, startStream, fetchSnapshot, stopStream]);

  // Actions
  const handleCopyAll = () => {
    const text = entries.map((e) => e.text || e.raw).join("\n");
    navigator.clipboard.writeText(text);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const handleExport = () => {
    const text = entries.map((e) => `[${e.timestamp}] [${e.level}] ${e.text}`).join("\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `router-console-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearBuffer = async () => {
    if (!window.confirm("Are you sure you want to clear the server console log buffer?")) {
      return;
    }
    try {
      await fetch("/api/console-logs", { method: "DELETE" });
      setEntries([]);
      setStats({ total: 0, errors: 0, warnings: 0 });
    } catch (err) {
      console.error("Failed to clear console buffer:", err);
    }
  };

  const handleClearView = () => {
    setEntries([]);
  };

  return (
    <div className="flex flex-col gap-4 p-6 min-h-screen">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-text-muted/70 uppercase tracking-wider">
              System
            </span>
            <span className="text-text-muted/40">/</span>
            <span className="text-xs font-semibold text-primary uppercase tracking-wider">
              Console Logs
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-text-main flex items-center gap-3">
            Console Log Viewer
            {mode === "stream" ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                Live Stream
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <span className="size-2 rounded-full bg-amber-500" />
                Snapshot Mode
              </span>
            )}
            {copyFeedback && (
              <span className="text-xs font-medium text-emerald-400 animate-fade-in">
                ✓ Copied to clipboard!
              </span>
            )}
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            Real-time streaming and historical snapshot inspection of router stdout and stderr.
          </p>
        </div>
      </div>

      {/* Control Toolbar */}
      <LogToolbar
        mode={mode}
        setMode={setMode}
        tail={tail}
        setTail={setTail}
        since={since}
        setSince={setSince}
        selectedLevel={selectedLevel}
        setSelectedLevel={setSelectedLevel}
        search={search}
        setSearch={setSearch}
        isRegex={isRegex}
        setIsRegex={setIsRegex}
        isCaseSensitive={isCaseSensitive}
        setIsCaseSensitive={setIsCaseSensitive}
        autoScroll={autoScroll}
        setAutoScroll={setAutoScroll}
        wrapLines={wrapLines}
        setWrapLines={setWrapLines}
        showTimestamps={showTimestamps}
        setShowTimestamps={setShowTimestamps}
        streaming={streaming}
        loading={loading}
        onRefresh={fetchSnapshot}
        onClearLogs={handleClearBuffer}
        onExport={handleExport}
        onCopyAll={handleCopyAll}
        stats={stats}
      />

      {/* Interactive Log Terminal */}
      <LogTerminal
        entries={entries}
        loading={loading}
        search={search}
        isRegex={isRegex}
        isCaseSensitive={isCaseSensitive}
        autoScroll={autoScroll}
        wrapLines={wrapLines}
        showTimestamps={showTimestamps}
        onClearView={handleClearView}
      />
    </div>
  );
}
