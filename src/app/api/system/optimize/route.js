import { NextResponse } from "next/server";
import {
  estimateOptimizationSavings,
  runSystemOptimization,
} from "@/lib/system/systemOptimizer.js";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const estimates = estimateOptimizationSavings();
    return NextResponse.json({
      ok: true,
      data: estimates,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to estimate savings",
      },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const retentionDays = Number(body.retentionDays) || 7;
    const force = body.force === true;

    const audit = await runSystemOptimization({ retentionDays, force });

    return NextResponse.json({
      ok: true,
      audit,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Optimization failed",
      },
      { status: 500 }
    );
  }
}
