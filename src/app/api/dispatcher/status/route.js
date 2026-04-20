import { NextResponse } from "next/server";
import { getDispatcherStatusSnapshot } from "@/lib/dispatcher/metrics.js";
import { getCodexDispatcher } from "@/lib/dispatcher/index.js";
import { getSettings } from "@/lib/localDb.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { dispatcher, watchdog } = getCodexDispatcher();
    const [settings, connectionViews] = await Promise.all([
      getSettings(),
      dispatcher?.getConnections?.() || [],
    ]);
    const inMemory = dispatcher?.getInMemorySnapshot?.() || null;
    const snapshot = getDispatcherStatusSnapshot({
      provider: "codex",
      settings,
      inMemory,
      connectionViews,
    });
    return NextResponse.json({
      ...snapshot,
      watchdog: {
        timeoutPolicy: watchdog?.timeoutPolicy || null,
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
