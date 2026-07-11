import { NextResponse } from "next/server";
import { getDispatcherStatusSnapshot } from "@/lib/dispatcher/metrics.js";
import {
  getProviderDispatcher,
  TEXT_DISPATCH_PROVIDERS,
} from "@/lib/dispatcher/index.js";
import { getConnectionCollections, getSettings } from "@/lib/localDb.js";

export const dynamic = "force-dynamic";

/**
 * GET /api/dispatcher/text/status
 * Query:
 *  - provider=codex|antigravity|grok-cli (default codex)
 *  - view=live|history|full (default live for cheaper multi-pool polls)
 *  - terminalLimit=100
 */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const providerParam = searchParams.get("provider") || "codex";
    const provider = TEXT_DISPATCH_PROVIDERS.includes(providerParam)
      ? providerParam
      : "codex";
    const viewParam = searchParams.get("view") || "live";
    const view = ["live", "history", "full"].includes(viewParam)
      ? viewParam
      : "live";
    const terminalLimit = Math.max(
      1,
      Math.min(500, Number(searchParams.get("terminalLimit")) || 100),
    );

    const { dispatcher, watchdog, getConnections } =
      getProviderDispatcher(provider);
    const [settings, connectionViews, collections] = await Promise.all([
      getSettings(),
      getConnections?.() || [],
      getConnectionCollections(),
    ]);
    const inMemory = dispatcher?.getInMemorySnapshot?.() || null;
    const snapshot = getDispatcherStatusSnapshot({
      provider,
      settings,
      inMemory,
      connectionViews,
      view,
      terminalLimit,
    });
    const selectedCollection =
      provider === "codex"
        ? collections.find(
            (collection) =>
              collection.id === settings.textDispatcherCollectionId,
          ) || null
        : null;
    return NextResponse.json({
      ...snapshot,
      selectedCollection,
      watchdog: {
        timeoutPolicy: watchdog?.timeoutPolicy || null,
      },
      retention: {
        attemptsRetentionHours: 24,
        affinityRetentionDays: 7,
      },
      inMemory:
        view === "live" || view === "full"
          ? {
              occupancyByConnection: inMemory?.occupancyByConnection || {},
              leaseCountByConnection: inMemory?.leaseCountByConnection || {},
              leaseMetrics: inMemory?.leaseMetrics || null,
            }
          : undefined,
    });
  } catch (error) {
    console.error("[API] Failed to fetch dispatcher status:", error);
    return NextResponse.json(
      { error: "Failed to fetch dispatcher status" },
      { status: 500 },
    );
  }
}
