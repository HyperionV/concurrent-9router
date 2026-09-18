import { NextResponse } from "next/server";
import { getConsoleBuffer } from "@/lib/consoleBuffer.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const tail = searchParams.get("tail") ? Number.parseInt(searchParams.get("tail"), 10) : 500;
    const since = searchParams.get("since") || null;
    const level = searchParams.get("level") || null;
    const search = searchParams.get("search") || "";
    const regex = searchParams.get("regex") === "true";
    const caseSensitive = searchParams.get("caseSensitive") === "true";

    const buffer = getConsoleBuffer();
    const result = buffer.getEntries({
      tail,
      since,
      level,
      search,
      regex,
      caseSensitive,
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to fetch console logs" },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  try {
    const buffer = getConsoleBuffer();
    buffer.clear();
    return NextResponse.json({ success: true, message: "Console buffer cleared" });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error?.message || "Failed to clear console buffer" },
      { status: 500 },
    );
  }
}
