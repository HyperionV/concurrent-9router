import { NextResponse } from "next/server";
import { getUsageStats, validateCustomUsageRange } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["24h", "7d", "30d", "60d", "all", "custom"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const start = searchParams.get("start");
    const end = searchParams.get("end");

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    if (period === "custom") {
      const validation = validateCustomUsageRange({ start, end });
      if (validation.error) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }
    }

    const stats = await getUsageStats(period, { start, end });
    return NextResponse.json(stats);
  } catch (error) {
    console.error("[API] Failed to get usage stats:", error);
    return NextResponse.json({ error: "Failed to fetch usage stats" }, { status: 500 });
  }
}
