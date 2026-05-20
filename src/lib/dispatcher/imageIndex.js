import { createImageDispatcherCore } from "@/lib/dispatcher/imageCore.js";
import { buildDispatchConnectionView } from "@/lib/dispatcher/connectionState.js";
import { getProviderConnections, getSettings } from "@/lib/localDb.js";

const IMAGE_DISPATCHER_KEY = Symbol.for("nine-router.image-dispatcher");

let lastKnownImageSlotsPerConnection = 1;

async function getCodexImageSettings() {
  const settings = await getSettings();
  lastKnownImageSlotsPerConnection =
    settings.imageDispatcherSlotsPerConnection ?? 1;
  return settings;
}

async function getCodexImageConnections() {
  const settings = await getCodexImageSettings();
  const connections = await getProviderConnections({
    provider: "codex",
    isActive: true,
    collectionId: settings.imageDispatcherCollectionId || undefined,
  });
  return Promise.all(connections.map(buildDispatchConnectionView));
}

function getGlobalState() {
  if (!globalThis[IMAGE_DISPATCHER_KEY]) {
    globalThis[IMAGE_DISPATCHER_KEY] = {
      dispatcher: createImageDispatcherCore({
        provider: "codex",
        getConnections: getCodexImageConnections,
        getSlotsPerConnection: async () => {
          const settings = await getCodexImageSettings();
          return settings.imageDispatcherSlotsPerConnection;
        },
      }),
    };
  }

  globalThis[IMAGE_DISPATCHER_KEY].getConnections = getCodexImageConnections;
  globalThis[IMAGE_DISPATCHER_KEY].getSettings = getCodexImageSettings;

  return globalThis[IMAGE_DISPATCHER_KEY];
}

export function getCodexImageDispatcher() {
  return getGlobalState();
}
