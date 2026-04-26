import { NextResponse } from "next/server";
import { listImageDispatchAttemptsByState } from "@/lib/sqlite/imageDispatcherStore.js";
import { getCodexImageDispatcher } from "@/lib/dispatcher/imageIndex.js";

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

function summarizeTerminal(terminalAttempts) {
  const byState = {};
  for (const attempt of terminalAttempts) {
    byState[attempt.state] = (byState[attempt.state] || 0) + 1;
  }
  return {
    count: terminalAttempts.length,
    byState,
    recent: terminalAttempts.slice(0, 50),
  };
}

export async function GET() {
  try {
    const { dispatcher, getConnections } = getCodexImageDispatcher();
    const connectionViews = await getConnections();
    const snapshot = await dispatcher.getStatusSnapshot({ connectionViews });
    const terminalAttempts = listImageDispatchAttemptsByState([
      "completed",
      "failed",
      "timed_out",
      "cancelled",
      "reconciled",
    ]).filter((attempt) => attempt.provider === "codex");

    return NextResponse.json({
      provider: "codex",
      mode: "managed",
      alwaysOn: true,
      generatedAt: new Date().toISOString(),
      capacity: snapshot.capacity,
      queued: summarizeQueued(snapshot.queuedRequests),
      activeAttempts: snapshot.activeAttempts,
      queuedRequests: snapshot.queuedRequests,
      terminal: summarizeTerminal(terminalAttempts),
      connections: connectionViews.map((connection) => ({
        connectionId: connection.id,
        connectionName:
          connection.displayName ||
          connection.name ||
          connection.email ||
          connection.id,
        occupiedSlots: snapshot.occupancyByConnection[connection.id] || 0,
        capacity: 1,
        availableSlots:
          (snapshot.occupancyByConnection[connection.id] || 0) > 0 ? 0 : 1,
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
