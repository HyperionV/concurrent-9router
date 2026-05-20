import { NextResponse } from "next/server";
import {
  getConnectionCollections,
  getSettings,
  updateSettings,
} from "@/lib/localDb.js";
import { normalizeImageDispatcherSlotsPerConnection } from "@/lib/dispatcher/settings.js";

function toSafeImageDispatcherSettings(settings) {
  return {
    mode: "managed",
    alwaysOn: true,
    imageDispatcherCollectionId: settings.imageDispatcherCollectionId || null,
    imageDispatcherSlotsPerConnection:
      Number(settings.imageDispatcherSlotsPerConnection) || 1,
  };
}

export async function GET() {
  try {
    const settings = await getSettings();
    return NextResponse.json(toSafeImageDispatcherSettings(settings));
  } catch (error) {
    console.error("[API] Failed to fetch image dispatcher settings:", error);
    return NextResponse.json(
      { error: "Failed to fetch image dispatcher settings" },
      { status: 500 },
    );
  }
}

export async function PATCH(request) {
  try {
    const body = await request.json();
    const updates = {};

    if (body.imageDispatcherSlotsPerConnection !== undefined) {
      updates.imageDispatcherSlotsPerConnection =
        normalizeImageDispatcherSlotsPerConnection(
          body.imageDispatcherSlotsPerConnection,
        );
    }

    if (body.imageDispatcherCollectionId !== undefined) {
      const validCollectionIds = new Set(
        (await getConnectionCollections()).map((collection) => collection.id),
      );
      if (!validCollectionIds.has(body.imageDispatcherCollectionId)) {
        return NextResponse.json(
          { error: "Selected image dispatcher collection was not found" },
          { status: 400 },
        );
      }
      updates.imageDispatcherCollectionId =
        body.imageDispatcherCollectionId || null;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "No image dispatcher settings update was provided" },
        { status: 400 },
      );
    }

    const settings = await updateSettings({
      ...updates,
      dispatcherEnabled: true,
      dispatcherShadowMode: false,
      dispatcherCodexOnly: true,
      codexDefaultAdmissionPolicy: "managed",
    });

    return NextResponse.json(toSafeImageDispatcherSettings(settings));
  } catch (error) {
    console.error("[API] Failed to update image dispatcher settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update image dispatcher settings" },
      { status: 400 },
    );
  }
}
