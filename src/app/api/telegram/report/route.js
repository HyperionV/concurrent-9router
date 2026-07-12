import { NextResponse } from "next/server";
import { sendUsageReport } from "@/lib/telegram.js";
import { getSettings } from "@/lib/localDb.js";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const settings = await getSettings();
    if (settings && settings.telegramEnabled === false) {
      return NextResponse.json(
        { error: "Telegram notifications are disabled in settings." },
        { status: 400 }
      );
    }

    const success = await sendUsageReport();
    if (!success) {
      return NextResponse.json(
        { error: "Failed to send report. Check if bot token and chat ID are configured." },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[API] Failed to manually trigger Telegram report:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
