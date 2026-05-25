import { NextResponse } from "next/server";
import { getChartData, validateCustomUsageRange } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["24h", "7d", "30d", "60d", "custom"]);
const VALID_STEPS = new Set(["hour", "day", "custom"]);

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";
    const step = searchParams.get("step") || "day";
    const start = searchParams.get("start");
    const end = searchParams.get("end");
    const stepSize = searchParams.get("stepSize");
    const stepUnit = searchParams.get("stepUnit");

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }
    if (!VALID_STEPS.has(step)) {
      return NextResponse.json({ error: "Invalid step" }, { status: 400 });
    }
    if (period === "custom") {
      const validation = validateCustomUsageRange(
        { start, end, stepSize, stepUnit },
        step,
      );
      if (validation.error) {
        return NextResponse.json({ error: validation.error }, { status: 400 });
      }
    }

    const data = await getChartData(period, {
      start,
      end,
      step,
      stepSize,
      stepUnit,
    });
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json(
      { error: "Failed to fetch chart data" },
      { status: 500 },
    );
  }
}
