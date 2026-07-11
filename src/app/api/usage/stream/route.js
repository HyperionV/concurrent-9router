import { getUsageStats, statsEmitter, getActiveRequests } from "@/lib/usageDb";

export const dynamic = "force-dynamic";

// OPT-010: debounce full getUsageStats rebuilds under bursty traffic
const FULL_STATS_DEBOUNCE_MS = 1500;

export async function GET() {
  const encoder = new TextEncoder();
  const state = {
    closed: false,
    keepalive: null,
    send: null,
    sendPending: null,
    cachedStats: null,
    fullRefreshTimer: null,
    fullRefreshInFlight: false,
  };

  const stream = new ReadableStream({
    async start(controller) {
      const pushQuick = async () => {
        if (state.closed || !state.cachedStats) return;
        const { activeRequests, recentRequests, errorProvider } =
          await getActiveRequests();
        const quickStats = {
          ...state.cachedStats,
          activeRequests,
          recentRequests,
          errorProvider,
        };
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(quickStats)}\n\n`),
        );
      };

      const runFullRefresh = async () => {
        if (state.closed || state.fullRefreshInFlight) return;
        state.fullRefreshInFlight = true;
        try {
          const stats = await getUsageStats();
          if (state.closed) return;
          state.cachedStats = stats;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(stats)}\n\n`),
          );
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
          if (state.fullRefreshTimer) clearTimeout(state.fullRefreshTimer);
        } finally {
          state.fullRefreshInFlight = false;
        }
      };

      // Full stats refresh (heavy) debounced + immediate lightweight push
      state.send = async () => {
        if (state.closed) return;
        try {
          await pushQuick();
          if (state.fullRefreshTimer) clearTimeout(state.fullRefreshTimer);
          state.fullRefreshTimer = setTimeout(() => {
            state.fullRefreshTimer = null;
            runFullRefresh().catch(() => {});
          }, FULL_STATS_DEBOUNCE_MS);
          state.fullRefreshTimer.unref?.();
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
          if (state.fullRefreshTimer) clearTimeout(state.fullRefreshTimer);
        }
      };

      // Lightweight push: only refresh activeRequests + recentRequests on pending changes
      state.sendPending = async () => {
        if (state.closed || !state.cachedStats) return;
        try {
          const { activeRequests, recentRequests, errorProvider } = await getActiveRequests();
          const stats = { ...state.cachedStats, activeRequests, recentRequests, errorProvider };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(stats)}\n\n`));
        } catch {
          state.closed = true;
          statsEmitter.off("update", state.send);
          statsEmitter.off("pending", state.sendPending);
          clearInterval(state.keepalive);
        }
      };

      // Initial full load (not debounced)
      try {
        const stats = await getUsageStats();
        state.cachedStats = stats;
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(stats)}\n\n`),
        );
      } catch {
        state.closed = true;
      }

      statsEmitter.on("update", state.send);
      statsEmitter.on("pending", state.sendPending);

      state.keepalive = setInterval(() => {
        if (state.closed) { clearInterval(state.keepalive); return; }
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.closed = true;
          clearInterval(state.keepalive);
        }
      }, 25000);
    },

    cancel() {
      state.closed = true;
      statsEmitter.off("update", state.send);
      statsEmitter.off("pending", state.sendPending);
      clearInterval(state.keepalive);
      if (state.fullRefreshTimer) clearTimeout(state.fullRefreshTimer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
