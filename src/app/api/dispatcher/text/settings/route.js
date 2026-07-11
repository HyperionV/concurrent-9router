import { NextResponse } from "next/server";
import {
  getConnectionCollections,
  getSettings,
  updateSettings,
} from "@/lib/localDb.js";
import {
  deriveDispatcherMode,
  getDispatcherSlotsPerConnection,
  isTextDispatchProvider,
  normalizeDispatcherSlotsByProvider,
  normalizeDispatcherSlotsPerConnection,
  patchDispatcherSlotsForProvider,
  TEXT_DISPATCH_PROVIDERS,
} from "@/lib/dispatcher/settings.js";
import { invalidateDispatcherConnectionCache } from "@/lib/dispatcher/connectionCache.js";

function toSafeDispatcherSettings(settings, provider = "codex") {
  const slotsByProvider = normalizeDispatcherSlotsByProvider(
    settings.dispatcherSlotsByProvider,
    settings.dispatcherSlotsPerConnection,
  );
  const resolvedProvider = isTextDispatchProvider(provider)
    ? provider
    : "codex";
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
    // Isolated slots map — each provider has its own value
    dispatcherSlotsByProvider: slotsByProvider,
    // Convenience: slots for the requested provider (or codex)
    provider: resolvedProvider,
    dispatcherSlotsPerConnection: getDispatcherSlotsPerConnection(
      { ...settings, dispatcherSlotsByProvider: slotsByProvider },
      resolvedProvider,
    ),
    textDispatcherCollectionId: settings.textDispatcherCollectionId || null,
  };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") || "codex";
    const settings = await getSettings();
    return NextResponse.json(toSafeDispatcherSettings(settings, provider));
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
    const current = await getSettings();

    // Prefer explicit per-provider map patch when provided.
    if (
      body.dispatcherSlotsByProvider !== undefined &&
      body.dispatcherSlotsByProvider !== null &&
      typeof body.dispatcherSlotsByProvider === "object"
    ) {
      const merged = normalizeDispatcherSlotsByProvider(
        {
          ...normalizeDispatcherSlotsByProvider(
            current.dispatcherSlotsByProvider,
            current.dispatcherSlotsPerConnection,
          ),
          ...body.dispatcherSlotsByProvider,
        },
        current.dispatcherSlotsPerConnection,
      );
      // Re-validate any keys present in the body.
      for (const provider of TEXT_DISPATCH_PROVIDERS) {
        if (body.dispatcherSlotsByProvider[provider] !== undefined) {
          merged[provider] = normalizeDispatcherSlotsPerConnection(
            body.dispatcherSlotsByProvider[provider],
          );
        }
      }
      updates.dispatcherSlotsByProvider = merged;
      updates.dispatcherSlotsPerConnection = merged.codex;
    } else if (body.dispatcherSlotsPerConnection !== undefined) {
      // Single-provider update. Default provider is codex for backward compat.
      const provider =
        body.provider && isTextDispatchProvider(body.provider)
          ? body.provider
          : "codex";
      Object.assign(
        updates,
        patchDispatcherSlotsForProvider(
          current,
          provider,
          body.dispatcherSlotsPerConnection,
        ),
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
        current.codexDefaultAdmissionPolicy ||
        "managed",
    });
    invalidateDispatcherConnectionCache();
    const responseProvider =
      body.provider && isTextDispatchProvider(body.provider)
        ? body.provider
        : "codex";
    return NextResponse.json(
      toSafeDispatcherSettings(settings, responseProvider),
    );
  } catch (error) {
    console.error("[API] Failed to update dispatcher settings:", error);
    return NextResponse.json(
      { error: error.message || "Failed to update dispatcher settings" },
      { status: 400 },
    );
  }
}
