"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { Copy, Check, Terminal, AlertCircle, AlertTriangle, Zap, Route } from "lucide-react";

const LEVEL_STYLES = {
  ERROR: {
    badge: "bg-red-500/20 text-red-400 border-red-500/40",
    rowBg: "hover:bg-red-500/5",
    icon: AlertCircle,
  },
  WARN: {
    badge: "bg-amber-500/20 text-amber-400 border-amber-500/40",
    rowBg: "hover:bg-amber-500/5",
    icon: AlertTriangle,
  },
  DISPATCHER: {
    badge: "bg-cyan-500/20 text-cyan-300 border-cyan-500/40",
    rowBg: "hover:bg-cyan-500/5",
    icon: Zap,
  },
  REQUEST: {
    badge: "bg-sky-500/20 text-sky-300 border-sky-500/40",
    rowBg: "hover:bg-sky-500/5",
  },
  USAGE: {
    badge: "bg-purple-500/20 text-purple-300 border-purple-500/40",
    rowBg: "hover:bg-purple-500/5",
  },
  DEBUG: {
    badge: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
    rowBg: "hover:bg-emerald-500/5",
  },
  INFO: {
    badge: "bg-zinc-700/40 text-zinc-300 border-zinc-600/40",
    rowBg: "hover:bg-white/5",
  },
};

function formatTimestamp(isoStr) {
  if (!isoStr) return "";
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return isoStr;
  }
}

function HighlightedText({ text, search, isRegex, isCaseSensitive }) {
  if (!search || !search.trim()) {
    return <span>{text}</span>;
  }

  let regex;
  try {
    const pattern = isRegex
      ? search.trim()
      : search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    regex = new RegExp(`(${pattern})`, isCaseSensitive ? "g" : "gi");
  } catch {
    return <span>{text}</span>;
  }

  const parts = text.split(regex);
  return (
    <span>
      {parts.map((part, index) => {
        const isMatch = isCaseSensitive
          ? part === search.trim()
          : part.toLowerCase() === search.trim().toLowerCase();
        if (isMatch) {
          return (
            <mark
              key={index}
              className="bg-yellow-400 text-black px-0.5 rounded font-semibold"
            >
              {part}
            </mark>
          );
        }
        return <span key={index}>{part}</span>;
      })}
    </span>
  );
}

export default function LogTerminal({
  entries,
  loading,
  search,
  isRegex,
  isCaseSensitive,
  autoScroll,
  wrapLines,
  showTimestamps,
  onClearView,
}) {
  const scrollRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const [copiedId, setCopiedId] = useState(null);

  // Monitor user scrolling to detect if at bottom
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceToBottom < 50;
  };

  // Sticky bottom auto-scroll
  useEffect(() => {
    if (autoScroll && isNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  const copyLine = (entry) => {
    navigator.clipboard.writeText(entry.text || entry.raw || "");
    setCopiedId(entry.id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  return (
    <div className="flex-1 min-h-0 w-full flex flex-col rounded-xl overflow-hidden border border-border bg-[#0a0d14] shadow-xl">
      {/* Terminal Title Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#121620] border-b border-white/5 select-none">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className="size-2.5 rounded-full bg-[#ff5f56]" />
            <div className="size-2.5 rounded-full bg-[#ffbd2e]" />
            <div className="size-2.5 rounded-full bg-[#27c93f]" />
          </div>
          <span className="text-xs font-mono text-zinc-400 ml-2 flex items-center gap-1.5">
            <Terminal className="size-3.5 text-zinc-500" />
            router-stdout-stderr.log
          </span>
        </div>

        <div className="flex items-center gap-3 text-xs font-mono text-zinc-400">
          <span>{entries.length} lines</span>
          {entries.length > 0 && (
            <button
              onClick={onClearView}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
              title="Clear current view"
            >
              Clear view
            </button>
          )}
        </div>
      </div>

      {/* Terminal Log Area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 p-3 overflow-y-auto overflow-x-auto font-mono text-xs leading-relaxed text-zinc-200 select-text custom-scrollbar"
        style={{ scrollBehavior: "smooth" }}
      >
        {loading && entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500 gap-2">
            <div className="size-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            <span>Buffering router logs...</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-500 gap-1 select-none">
            <Terminal className="size-8 text-zinc-600 mb-2" />
            <p className="font-medium text-zinc-400">No console logs recorded</p>
            <p className="text-[11px] text-zinc-600">
              Logs from stdout and stderr will stream here automatically.
            </p>
          </div>
        ) : (
          entries.map((entry, index) => {
            const levelStyle = LEVEL_STYLES[entry.level] || LEVEL_STYLES.INFO;
            const isCopied = copiedId === entry.id;

            return (
              <div
                key={entry.id || index}
                className={`group flex items-start gap-2 py-0.5 px-1.5 rounded transition-colors ${
                  levelStyle.rowBg
                }`}
              >
                {/* Line number */}
                <span className="text-zinc-600 select-none text-[11px] w-10 text-right shrink-0 pt-0.5">
                  {index + 1}
                </span>

                {/* Timestamp */}
                {showTimestamps && (
                  <span className="text-zinc-500 select-none text-[11px] shrink-0 pt-0.5">
                    {formatTimestamp(entry.timestamp)}
                  </span>
                )}

                {/* Level badge */}
                <span
                  className={`inline-block px-1.5 py-0.2 text-[10px] font-semibold uppercase rounded border select-none shrink-0 ${levelStyle.badge}`}
                >
                  {entry.level}
                </span>

                {/* Message body */}
                <span
                  className={`flex-1 text-zinc-200 ${
                    wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre"
                  }`}
                >
                  <HighlightedText
                    text={entry.text}
                    search={search}
                    isRegex={isRegex}
                    isCaseSensitive={isCaseSensitive}
                  />
                </span>

                {/* Hover action: Copy single line */}
                <button
                  onClick={() => copyLine(entry)}
                  className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-zinc-200 transition-opacity p-0.5 rounded hover:bg-white/10 shrink-0"
                  title="Copy line"
                >
                  {isCopied ? (
                    <Check className="size-3.5 text-emerald-400" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
