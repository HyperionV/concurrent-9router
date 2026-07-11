/**
 * Grok CLI usage — Settings weekly % comes from format=credits creditUsagePercent,
 * NOT plain /v1/billing used/monthlyLimit (dollar ledger).
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseGrokCliBilling, getUsageForProvider } from "./usage.js";

test("creditUsagePercent maps to Weekly used% matching Settings UI", () => {
  // Live capture shape: format=credits has creditUsagePercent + weekly period;
  // plain billing has used/monthlyLimit monthly dollars (different metric).
  const merged = {
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-07-07T15:12:46.338556+00:00",
        end: "2026-07-14T15:12:46.338556+00:00",
      },
      creditUsagePercent: 74,
      productUsage: [
        { product: "GrokBuild", usagePercent: 74 },
        { product: "GrokChat" },
      ],
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
      billingPeriodStart: "2026-07-07T15:12:46.338556+00:00",
      billingPeriodEnd: "2026-07-14T15:12:46.338556+00:00",
      // dollar ledger (would wrongly show ~79% remaining if used alone)
      used: { val: 3277 },
      monthlyLimit: { val: 15000 },
    },
  };

  const parsed = parseGrokCliBilling(merged, {
    subscriptionTier: "GrokPro",
    hasGrokCodeAccess: true,
  });

  assert.ok(parsed.quotas.Weekly);
  assert.equal(parsed.quotas.Weekly.usedPercentage, 74);
  assert.equal(parsed.quotas.Weekly.remainingPercentage, 26);
  assert.equal(parsed.quotas.Weekly.displayAsUsed, true);
  assert.equal(parsed.quotas["On-demand"], undefined);
  // Dollar ledger as secondary row
  assert.ok(parsed.quotas["Credits ($)"]);
  assert.equal(parsed.plan, "Grok Pro");
});

test("GrokBuild productUsage preferred over overall creditUsagePercent", () => {
  const parsed = parseGrokCliBilling({
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
      creditUsagePercent: 50,
      productUsage: [{ product: "GrokBuild", usagePercent: 73 }],
    },
  });
  assert.equal(parsed.quotas.Weekly.usedPercentage, 73);
  assert.equal(Math.round(parsed.quotas.Weekly.remainingPercentage), 27);
});

test("falls back to used/monthlyLimit when no creditUsagePercent", () => {
  const parsed = parseGrokCliBilling({
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
      used: { val: 2900 },
      monthlyLimit: { val: 10000 },
      billingPeriodEnd: "2026-07-14T15:12:00+00:00",
    },
  });
  assert.equal(Math.round(parsed.quotas.Weekly.remainingPercentage), 71);
  assert.notEqual(parsed.quotas.Weekly.displayAsUsed, true);
});

test("on-demand only when cap > 0", () => {
  const parsed = parseGrokCliBilling({
    config: {
      creditUsagePercent: 10,
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
      onDemandCap: { val: 10000 },
      onDemandUsed: { val: 2500 },
    },
  });
  assert.ok(parsed.quotas["On-demand"]);
  assert.equal(parsed.quotas["On-demand"].total, 100); // cents → dollars
  assert.equal(parsed.quotas["On-demand"].used, 25);
});

test("getUsageForProvider routes grok-cli", async () => {
  const result = await getUsageForProvider({
    provider: "grok-cli",
    accessToken: null,
  });
  assert.match(result.message || "", /access token/i);
  assert.doesNotMatch(result.message || "", /not implemented/i);
});
