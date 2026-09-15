import { NextResponse } from "next/server";
import { getSystemTelemetry } from "@/lib/system/statsCollector.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const telemetry = getSystemTelemetry();
    return NextResponse.json({
      ok: true,
      data: telemetry,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to collect system status",
      },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const action = body.action || "gc";

    if (action === "gc") {
      if (typeof global.gc === "function") {
        const memBefore = process.memoryUsage();
        global.gc();
        const memAfter = process.memoryUsage();
        return NextResponse.json({
          ok: true,
          message: "Garbage collection executed",
          freedBytes: Math.max(0, memBefore.heapUsed - memAfter.heapUsed),
          before: memBefore,
          after: memAfter,
        });
      }
      return NextResponse.json({
        ok: false,
        message: "Garbage collection is not exposed in this Node runtime (requires --expose-gc)",
      });
    }

    return NextResponse.json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Action failed",
      },
      { status: 500 }
    );
  }
}
