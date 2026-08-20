/**
 * Connection Health Management
 * Handles automatic disabling of connections that receive 429 rate limit errors
 */

import { getSqlite } from "@/lib/sqlite/runtime.js";
import { invalidateDispatcherConnectionCache } from "@/lib/dispatcher/connectionCache.js";

/** Duration for 429 auto-disable: 24 hours in milliseconds */
export const RATE_LIMIT_DISABLE_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Check if a connection is currently disabled due to rate limiting
 * @param {string} connectionId - Connection ID
 * @returns {boolean} True if the connection is rate-limited disabled
 */
export function isRateLimitDisabled(connectionId) {
  const db = getSqlite();
  const row = db
    .prepare("SELECT disabled_until FROM provider_connections WHERE id = ?")
    .get(connectionId);

  if (!row || !row.disabled_until) return false;
  return new Date(row.disabled_until).getTime() > Date.now();
}

/**
 * Check if a connection object is currently disabled due to rate limiting
 * @param {object} connection - Connection object with disabledUntil field
 * @returns {boolean} True if the connection is rate-limited disabled
 */
export function isConnectionRateLimitDisabled(connection) {
  if (!connection || !connection.disabledUntil) return false;
  return new Date(connection.disabledUntil).getTime() > Date.now();
}

/**
 * Filter out connections that are disabled due to rate limiting
 * @param {Array} connections - Array of connection objects
 * @returns {Array} Filtered connections excluding rate-limited ones
 */
export function filterOutRateLimitedConnections(connections) {
  return connections.filter((conn) => !isConnectionRateLimitDisabled(conn));
}

/**
 * Get the disabled_until timestamp for a connection
 * @param {string} connectionId - Connection ID
 * @returns {Date|null} Date when the connection will be re-enabled, or null
 */
export function getRateLimitDisabledUntil(connectionId) {
  const db = getSqlite();
  const row = db
    .prepare("SELECT disabled_until FROM provider_connections WHERE id = ?")
    .get(connectionId);

  if (!row || !row.disabled_until) return null;
  return new Date(row.disabled_until);
}

/**
 * Auto-disable a connection for 24 hours due to receiving a 429 error
 * Only disables if not already disabled (extends if already disabled)
 * @param {string} connectionId - Connection ID
 * @param {number} [durationMs] - Duration to disable in ms (defaults to 24 hours)
 * @returns {boolean} True if the connection was disabled
 */
export function autoDisableForRateLimit(connectionId, durationMs = RATE_LIMIT_DISABLE_DURATION_MS) {
  const db = getSqlite();
  const now = Date.now();
  const disableUntil = new Date(now + durationMs).toISOString();

  const result = db
    .prepare(
      `
      UPDATE provider_connections
      SET disabled_until = ?
      WHERE id = ?
    `
    )
    .run(disableUntil, connectionId);

  if (result.changes > 0) {
    // Invalidate dispatcher connection cache so the next request picks
    // an available connection immediately instead of reusing the cached list.
    try {
      invalidateDispatcherConnectionCache();
    } catch {
      /* invalidate is best-effort */
    }
  }

  return result.changes > 0;
}

/**
 * Re-enable a connection that was disabled due to rate limiting
 * This clears the disabled_until field, allowing the connection to be used again
 * @param {string} connectionId - Connection ID
 * @returns {boolean} True if the connection was re-enabled
 */
export function reEnableRateLimitedConnection(connectionId) {
  const db = getSqlite();

  const result = db
    .prepare(
      `
      UPDATE provider_connections
      SET disabled_until = NULL
      WHERE id = ? AND disabled_until IS NOT NULL
    `
    )
    .run(connectionId);

  if (result.changes > 0) {
    try {
      invalidateDispatcherConnectionCache();
    } catch {
      /* invalidate is best-effort */
    }
  }

  return result.changes > 0;
}

/**
 * Check if a 429 error indicates usage limit exceeded
 * This is used to determine if we should auto-disable the connection
 * @param {string} errorMessage - The error message from the 429 response
 * @returns {boolean} True if this is a usage limit exceeded error
 */
export function isUsageLimitError(errorMessage) {
  if (!errorMessage) return false;
  const lowerMsg = errorMessage.toLowerCase();

  // Match patterns like:
  // "You've used all the included free usage for model grok-4.6 for now"
  // "usage_limit_reached"
  // "rate_limit_exceeded"
  const usageLimitPatterns = [
    "used all the included",
    "usage_limit",
    "rate_limit",
    "quota",
    "limit exceeded",
    "free usage",
  ];

  return usageLimitPatterns.some((pattern) => lowerMsg.includes(pattern));
}

/**
 * Check if a connection should be auto-disabled for 429 errors
 * Only certain providers support this feature
 * @param {string} provider - Provider name
 * @returns {boolean} True if the provider supports auto-disable
 */
export function supportsRateLimitDisable(provider) {
  const supportedProviders = ["codex", "grok-cli", "grok", "openai-compatible-responses"];
  return supportedProviders.includes(provider);
}

/**
 * Get a human-readable description of when a connection will be re-enabled
 * @param {string} connectionId - Connection ID
 * @returns {string|null} Human-readable time until re-enable, or null if not disabled
 */
export function getRateLimitDisableHumanReadable(connectionId) {
  const disabledUntil = getRateLimitDisabledUntil(connectionId);
  if (!disabledUntil) return null;

  const diffMs = disabledUntil.getTime() - Date.now();
  if (diffMs <= 0) return "re-enabling soon";

  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);

  return `re-enables in ${parts.join(" ")}`;
}
