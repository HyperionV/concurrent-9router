import { NextResponse } from "next/server";
import { getDispatcherStatusSnapshot } from "@/lib/dispatcher/metrics.js";
import { getCodexDispatcher } from "@/lib/dispatcher/index.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { dispatcher, watchdog } = getCodexDispatcher();
    const snapshot = getDispatcherStatusSnapshot({ provider: "codex" });
    return NextResponse.json({
      ...snapshot,
      watchdog: {
        timeoutPolicy: watchdog?.timeoutPolicy || null,
      },
      inMemory: dispatcher?.getInMemorySnapshot?.() || null,
    });
  } catch (error) {
    console.error("[API] Failed to fetch dispatcher status:", error);
    return NextResponse.json(
      { error: "Failed to fetch dispatcher status" },
      { status: 500 },
    );
  }
}
