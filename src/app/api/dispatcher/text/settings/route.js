import { NextResponse } from "next/server";
import {
  getConnectionCollections,
  getSettings,
  updateSettings,
} from "@/lib/localDb.js";
import {
  deriveDispatcherMode,
  normalizeDispatcherSlotsPerConnection,
  TEXT_DISPATCH_PROVIDERS,
} from "@/lib/dispatcher/settings.js";
import { invalidateDispatcherConnectionCache } from "@/lib/dispatcher/connectionCache.js";

function toSafeDispatcherSettings(settings) {
  return {
    mode: deriveDispatcherMode(settings),
    dispatcherEnabled: settings.dispatcherEnabled === true,
    dispatcherShadowMode: settings.dispatcherShadowMode === true,
    dispatcherCodexOnly: settings.dispatcherCodexOnly !== false,
    // Global default when API key has no coding/production override
    codexDefaultAdmissionPolicy:
      settings.codexDefaultAdmissionPolicy || "managed",
    // Providers that share the same key-based admission rule
    textDispatchProviders: TEXT_DISPATCH_PROVIDERS,
    dispatcherSlotsPerConnection:
      Number(settings.dispatcherSlotsPerConnection) || 1,
    textDispatcherCollectionId: settings.textDispatcherCollectionId || null,
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

    if (body.dispatcherSlotsPerConnection !== undefined) {
      updates.dispatcherSlotsPerConnection =
        normalizeDispatcherSlotsPerConnection(
          body.dispatcherSlotsPerConnection,
        );
    }

    if (body.textDispatcherCollectionId !== undefined) {
      const validCollectionIds = new Set(
        (await getConnectionCollections()).map((collection) => collection.id),
      );
      if (!validCollectionIds.has(body.textDispatcherCollectionId)) {
        return NextResponse.json(
          { error: "Selected dispatcher collection was not found" },
          { status: 400 },
        );
      }
      updates.textDispatcherCollectionId =
        body.textDispatcherCollectionId || null;
    }

    if (body.codexDefaultAdmissionPolicy !== undefined) {
      updates.codexDefaultAdmissionPolicy =
        body.codexDefaultAdmissionPolicy === "legacy" ? "legacy" : "managed";
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "No dispatcher settings update was provided" },
        { status: 400 },
      );
    }

    const settings = await updateSettings({
      ...updates,
      dispatcherEnabled: true,
      dispatcherShadowMode: false,
      dispatcherCodexOnly: true,
      codexDefaultAdmissionPolicy:
        updates.codexDefaultAdmissionPolicy ||
        (await getSettings()).codexDefaultAdmissionPolicy ||
        "managed",
    });
    invalidateDispatcherConnectionCache();
    return NextResponse.json(toSafeDispatcherSettings(settings));
  } catch (error) {
    console.error("[API] Failed to update dispatcher settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update dispatcher settings" },
      { status: 400 },
    );
  }
}
