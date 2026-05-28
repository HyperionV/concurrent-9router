import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy.js";

export async function buildDispatchConnectionView(connection) {
  const resolvedProxy = await resolveConnectionProxyConfig(
    connection?.providerSpecificData || {},
  );

  return {
    ...connection,
    providerSpecificData: {
      ...(connection?.providerSpecificData || {}),
      connectionProxyEnabled: resolvedProxy.connectionProxyEnabled === true,
      connectionProxyUrl: resolvedProxy.connectionProxyUrl || "",
      connectionNoProxy: resolvedProxy.connectionNoProxy || "",
      connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
      strictProxy: resolvedProxy.strictProxy === true,
      vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
    },
    _connection: connection,
  };
}

export async function buildManagedCredentials(connection) {
  const dispatchView = await buildDispatchConnectionView(connection);
  return {
    apiKey: dispatchView.apiKey,
    accessToken: dispatchView.accessToken,
    refreshToken: dispatchView.refreshToken,
    idToken: dispatchView.idToken,
    email: dispatchView.email,
    expiresAt: dispatchView.expiresAt,
    expiresIn: dispatchView.expiresIn,
    projectId: dispatchView.projectId,
    connectionName:
      dispatchView.displayName ||
      dispatchView.name ||
      dispatchView.email ||
      dispatchView.id,
    copilotToken: dispatchView.providerSpecificData?.copilotToken,
    providerSpecificData: {
      ...(dispatchView.providerSpecificData || {}),
    },
    connectionId: dispatchView.id,
    testStatus: dispatchView.testStatus,
    lastError: dispatchView.lastError,
    _connection: dispatchView._connection || connection,
  };
}
