import { NextResponse } from "next/server";
import { getDispatcherStatusSnapshot } from "@/lib/dispatcher/metrics.js";
import { getCodexDispatcher } from "@/lib/dispatcher/index.js";
import { getConnectionCollections, getSettings } from "@/lib/localDb.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { dispatcher, watchdog, getConnections } = getCodexDispatcher();
    const [settings, connectionViews, collections] = await Promise.all([
      getSettings(),
      getConnections?.() || [],
      getConnectionCollections(),
    ]);
    const inMemory = dispatcher?.getInMemorySnapshot?.() || null;
    const snapshot = getDispatcherStatusSnapshot({
      provider: "codex",
      settings,
      inMemory,
      connectionViews,
    });
    const selectedCollection =
      collections.find(
        (collection) => collection.id === settings.textDispatcherCollectionId,
      ) || null;
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
      inMemory,
    });
  } catch (error) {
    console.error("[API] Failed to fetch dispatcher status:", error);
    return NextResponse.json(
      { error: "Failed to fetch dispatcher status" },
      { status: 500 },
    );
  }
}
