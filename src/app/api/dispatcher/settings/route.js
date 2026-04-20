import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb.js";
import {
  buildDispatcherModePatch,
  deriveDispatcherMode,
  normalizeDispatcherSlotsPerConnection,
} from "@/lib/dispatcher/settings.js";

function toSafeDispatcherSettings(settings) {
  return {
    mode: deriveDispatcherMode(settings),
    dispatcherEnabled: settings.dispatcherEnabled === true,
    dispatcherShadowMode: settings.dispatcherShadowMode === true,
    dispatcherCodexOnly: settings.dispatcherCodexOnly !== false,
    dispatcherSlotsPerConnection:
      Number(settings.dispatcherSlotsPerConnection) || 1,
  };
}

export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json(toSafeDispatcherSettings(settings));
  } catch (error) {
    console.error("[API] Failed to fetch dispatcher settings:", error);
    return NextResponse.json(
      { error: "Failed to fetch dispatcher settings" },
      { status: 500 },
    );
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const updates = {};

    if (body.mode !== undefined) {
      Object.assign(updates, buildDispatcherModePatch(body.mode));
    }

    if (body.dispatcherSlotsPerConnection !== undefined) {
      updates.dispatcherSlotsPerConnection =
        normalizeDispatcherSlotsPerConnection(
          body.dispatcherSlotsPerConnection,
        );
    }

    if (body.dispatcherCodexOnly !== undefined) {
      updates.dispatcherCodexOnly = body.dispatcherCodexOnly === true;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "No dispatcher settings update was provided" },
        { status: 400 },
      );
    }

    const settings = await updateSettings(updates);
    return NextResponse.json(toSafeDispatcherSettings(settings));
  } catch (error) {
    console.error("[API] Failed to update dispatcher settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update dispatcher settings" },
      { status: 400 },
    );
  }
}
