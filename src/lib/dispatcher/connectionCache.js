/**
 * OPT-003: short-lived connection view cache, shared so localDb can invalidate
 * without importing the full dispatcher singleton graph (avoids cycles).
 *
 * Process-global: Next/webpack may load this module more than once.
 */

const connectionCacheByProvider = (globalThis.__dispatcherConnectionCache ||=
  new Map());
export const CONNECTION_CACHE_TTL_MS = 1000;

export function getConnectionCacheEntry(provider) {
  return connectionCacheByProvider.get(provider) || null;
}

export function setConnectionCacheEntry(provider, entry) {
  connectionCacheByProvider.set(provider, entry);
}

export function invalidateDispatcherConnectionCache(provider = null) {
  if (provider) {
    connectionCacheByProvider.delete(provider);
    return;
  }
  connectionCacheByProvider.clear();
}
