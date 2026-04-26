import { createImageDispatcherCore } from "@/lib/dispatcher/imageCore.js";
import { buildDispatchConnectionView } from "@/lib/dispatcher/connectionState.js";
import { getProviderConnections } from "@/lib/localDb.js";

const IMAGE_DISPATCHER_KEY = Symbol.for("nine-router.image-dispatcher");

async function getCodexImageConnections() {
  const connections = await getProviderConnections({
    provider: "codex",
    isActive: true,
  });
  return Promise.all(connections.map(buildDispatchConnectionView));
}

function getGlobalState() {
  if (!globalThis[IMAGE_DISPATCHER_KEY]) {
    globalThis[IMAGE_DISPATCHER_KEY] = {
      dispatcher: createImageDispatcherCore({
        provider: "codex",
        getConnections: getCodexImageConnections,
      }),
      getConnections: getCodexImageConnections,
    };
  }
  return globalThis[IMAGE_DISPATCHER_KEY];
}

export function getCodexImageDispatcher() {
  return getGlobalState();
}
