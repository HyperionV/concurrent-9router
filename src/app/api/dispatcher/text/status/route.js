import { NextResponse } from "next/server";
import { getDispatcherStatusSnapshot } from "@/lib/dispatcher/metrics.js";
import { getProviderDispatcher } from "@/lib/dispatcher/index.js";
import { isTextDispatchProvider } from "@/lib/dispatcher/settings.js";
import { normalizeMetricsRange } from "@/lib/sqlite/dispatcherMetrics/window.js";
import { getSettings } from "@/lib/localDb.js";
import { dispatcherMetricsAggregator } from "@/lib/dispatcher/metricsAggregator.js";

export const dynamic = "force-dynamic";

const VIEWS = ["live", "history", "full"];

/**
 * GET /api/dispatcher/text/status
 * Query:
 *  - provider={providerId} (default codex)
 *  - view=live|history|full (default live; live is the cheap 3s poll)
 *  - range=1h|24h|7d (default 24h; used by history)
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerParam = searchParams.get("provider") || "codex";
    const provider = isTextDispatchProvider(providerParam) ? providerParam : "codex";
    const viewParam = searchParams.get("view");
    const view = VIEWS.includes(viewParam) ? viewParam : "live";
    const range = normalizeMetricsRange(searchParams.get("range"));

    const { dispatcher, watchdog, getConnections } = getProviderDispatcher(provider);
    const [settings, connectionViews] = await Promise.all([
      getSettings(),
      getConnections?.() || [],
    ]);
    if (view !== "live") {
      // History must include attempts that finished since the last periodic flush.
      dispatcherMetricsAggregator.flushToSqlite();
    }

    const snapshot = getDispatcherStatusSnapshot({
      provider,
      settings,
      inMemory: dispatcher?.getInMemorySnapshot?.() || null,
      connectionViews,
      view,
      range,
    });
    return NextResponse.json({
      ...snapshot,
      timeoutPolicy: watchdog?.timeoutPolicy || null,
    });
  } catch (error) {
    console.error("[API] Failed to fetch dispatcher status:", error);
    return NextResponse.json(
      { error: "Failed to fetch dispatcher status" },
      { status: 500 },
    );
  }
}
