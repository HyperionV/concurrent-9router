import { consoleBuffer } from "@/lib/consoleBuffer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const tail = Math.min(Math.max(Number.parseInt(searchParams.get("tail") || "200", 10), 1), 2000);
  const level = searchParams.get("level") || "ALL";
  const search = searchParams.get("search") || "";
  const regex = searchParams.get("regex") === "true";
  const caseSensitive = searchParams.get("caseSensitive") === "true";

  let searchRe = null;
  if (search.trim()) {
    if (regex) {
      try {
        searchRe = new RegExp(search.trim(), caseSensitive ? "" : "i");
      } catch {
        // Invalid regex, ignore searchRe
      }
    }
  }

  const matchesFilter = (entry) => {
    if (level && level.toUpperCase() !== "ALL") {
      if (entry.level !== level.toUpperCase()) return false;
    }
    if (!search.trim()) return true;

    if (searchRe) {
      return searchRe.test(entry.text);
    }
    if (caseSensitive) {
      return entry.text.includes(search.trim());
    }
    return entry.text.toLowerCase().includes(search.trim().toLowerCase());
  };

  const encoder = new TextEncoder();
  let keepaliveTimer = null;
  let logHandler = null;
  let clearHandler = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const sendEvent = (payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        if (logHandler) consoleBuffer.off("log", logHandler);
        if (clearHandler) consoleBuffer.off("clear", clearHandler);
        try {
          controller.close();
        } catch {}
      };

      // 1. Initial snapshot batch
      const initial = consoleBuffer.getEntries({
        tail,
        level,
        search,
        regex,
        caseSensitive,
      });

      sendEvent({
        type: "init",
        entries: initial.entries,
        totalBuffered: initial.totalBuffered,
        stats: initial.stats,
      });

      // 2. Real-time log listener
      logHandler = (entry) => {
        if (closed) return;
        if (matchesFilter(entry)) {
          sendEvent({
            type: "log",
            entry,
            stats: consoleBuffer.stats,
          });
        }
      };
      consoleBuffer.on("log", logHandler);

      // 3. Clear listener
      clearHandler = () => {
        if (closed) return;
        sendEvent({
          type: "clear",
          stats: { total: 0, errors: 0, warnings: 0 },
        });
      };
      consoleBuffer.on("clear", clearHandler);

      // 4. Heartbeat keepalive
      keepaliveTimer = setInterval(() => {
        if (closed) {
          clearInterval(keepaliveTimer);
          return;
        }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 15000);
    },

    cancel() {
      closed = true;
      if (keepaliveTimer) clearInterval(keepaliveTimer);
      if (logHandler) consoleBuffer.off("log", logHandler);
      if (clearHandler) consoleBuffer.off("clear", clearHandler);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
