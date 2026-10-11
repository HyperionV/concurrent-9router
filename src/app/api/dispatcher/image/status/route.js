import { NextResponse } from "next/server";
import { listImageDispatchAttemptsByState } from "@/lib/sqlite/imageDispatcherStore.js";
import { getCodexImageDispatcher } from "@/lib/dispatcher/imageIndex.js";
import { getConnectionCollections } from "@/lib/localDb.js";

export const dynamic = "force-dynamic";

function summarizeQueued(queuedRequests) {
  const oldestQueuedAt = queuedRequests[0]?.queuedAt || null;
  return {
    count: queuedRequests.length,
    oldestQueuedAt,
    oldestQueueAgeMs: oldestQueuedAt
      ? Math.max(0, Date.now() - new Date(oldestQueuedAt).getTime())
      : 0,
  };
}

const RECENT_TERMINAL_LIMIT = 50;

function summarizeTerminal(recentAttempts) {
  const byState = {};
  for (const attempt of recentAttempts) {
    byState[attempt.state] = (byState[attempt.state] || 0) + 1;
  }
  return { count: recentAttempts.length, byState, recent: recentAttempts };
}

export async function GET() {
  try {
    const {
      dispatcher,
      getConnections,
      getSettings: getImageSettings,
    } = getCodexImageDispatcher();
    const [settings, connectionViews, collections] = await Promise.all([
      getImageSettings(),
      getConnections(),
      getConnectionCollections(),
    ]);
    const snapshot = await dispatcher.getStatusSnapshot({ connectionViews });
    const capacityPerConnection = snapshot.capacity.capacityPerConnection;
    // Newest first, capped in SQL: the ledger holds 24h of attempts.
    const recentAttempts = listImageDispatchAttemptsByState(
      ["completed", "failed", "timed_out", "cancelled", "reconciled"],
      "codex",
      { limit: RECENT_TERMINAL_LIMIT },
    );

    const selectedCollection =
      collections.find(
        (collection) => collection.id === settings.imageDispatcherCollectionId,
      ) || null;

    return NextResponse.json({
      provider: "codex",
      mode: "managed",
      alwaysOn: true,
      selectedCollection,
      generatedAt: new Date().toISOString(),
      settings: {
        imageDispatcherCollectionId:
          settings.imageDispatcherCollectionId || null,
        imageDispatcherSlotsPerConnection: capacityPerConnection,
      },
      capacity: snapshot.capacity,
      queued: summarizeQueued(snapshot.queuedRequests),
      activeAttempts: snapshot.activeAttempts,
      queuedRequests: snapshot.queuedRequests,
      terminal: summarizeTerminal(recentAttempts),
      connections: connectionViews.map((connection) => ({
        connectionId: connection.id,
        connectionName:
          connection.displayName ||
          connection.name ||
          connection.email ||
          connection.id,
        occupiedSlots: snapshot.occupancyByConnection[connection.id] || 0,
        capacity: capacityPerConnection,
        availableSlots: Math.max(
          0,
          capacityPerConnection -
            (snapshot.occupancyByConnection[connection.id] || 0),
        ),
        proxyPoolId:
          connection.providerSpecificData?.connectionProxyPoolId || null,
      })),
      inMemory: {
        occupancyByConnection: snapshot.occupancyByConnection,
      },
    });
  } catch (error) {
    console.error("[API] Failed to fetch image dispatcher status:", error);
    return NextResponse.json(
      { error: "Failed to fetch image dispatcher status" },
      { status: 500 },
    );
  }
}
