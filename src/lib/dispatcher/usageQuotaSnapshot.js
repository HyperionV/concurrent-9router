import { dispatcherQuotaHealth } from "@/lib/dispatcher/quotaHealth.js";

// The usage-report rows that are an account's own plan allowance. Extra rows
// (Codex review and spark limits, Grok dollar ledger, on-demand, prepaid) do
// not stop ordinary requests, so they must not mark the account as running low.
const PLAN_ROWS_BY_PROVIDER = {
  codex: ["session", "weekly"],
  "grok-cli": ["Weekly", "Monthly", "Daily"],
};

function rowRemainingFraction(row) {
  if (Number.isFinite(row?.remainingPercentage)) {
    return row.remainingPercentage / 100;
  }
  if (row?.total > 0 && Number.isFinite(row.remaining)) {
    return row.remaining / row.total;
  }
  return null;
}

/** Lowest remaining share across the account's plan windows, or null if none reported. */
export function getPlanRemainingFraction(provider, usage) {
  const fractions = (PLAN_ROWS_BY_PROVIDER[provider] || [])
    .map((key) => rowRemainingFraction(usage?.quotas?.[key]))
    .filter((fraction) => fraction !== null);
  return fractions.length > 0 ? Math.min(...fractions) : null;
}

/**
 * Feed a freshly fetched usage report into the dispatcher's quota health so
 * account selection sees real numbers. Recorded for all models: the plan
 * windows are account-wide.
 */
export async function recordQuotaFromUsage(connection, usage) {
  const remainingFraction = getPlanRemainingFraction(connection.provider, usage);
  if (remainingFraction === null) return null;
  return dispatcherQuotaHealth.recordQuotaSnapshot({
    connectionId: connection.id,
    remainingFraction,
  });
}
