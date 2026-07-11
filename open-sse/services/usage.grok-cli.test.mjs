/**
 * Grok CLI usage parsing — billing?format=credits protobuf-json shape.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseGrokCliBilling, getUsageForProvider } from "./usage.js";

test("parseGrokCliBilling maps weekly pool from used + monthlyLimit (Settings UI)", () => {
  // SuperGrok weekly allowance: 29% used → 71% remaining (matches Settings copy)
  const parsed = parseGrokCliBilling(
    {
      config: {
        currentPeriod: {
          type: "USAGE_PERIOD_TYPE_WEEKLY",
          start: "2026-07-07T00:00:00+00:00",
          end: "2026-07-14T15:12:00+00:00",
        },
        used: { val: 2900 },
        monthlyLimit: { val: 10000 },
        onDemandCap: { val: 0 },
        onDemandUsed: { val: 0 },
        prepaidBalance: { val: 0 },
        billingPeriodEnd: "2026-07-14T15:12:00+00:00",
      },
    },
    { subscriptionTier: "super_grok", hasGrokCodeAccess: true },
  );

  assert.equal(parsed.plan, "Super Grok");
  assert.ok(parsed.quotas.Weekly, "primary bar is Weekly pool, not On-demand");
  assert.equal(parsed.quotas.Weekly.used, 2900);
  assert.equal(parsed.quotas.Weekly.total, 10000);
  assert.equal(Math.round(parsed.quotas.Weekly.remainingPercentage), 71);
  assert.equal(
    parsed.quotas["On-demand"],
    undefined,
    "onDemandCap=0 must not invent a 0% On-demand bar",
  );
});

test("parseGrokCliBilling maps on-demand only when cap > 0", () => {
  const parsed = parseGrokCliBilling(
    {
      config: {
        onDemandCap: { val: 100 },
        onDemandUsed: { val: 35 },
        billingPeriodEnd: "2026-08-01T00:00:00Z",
      },
    },
    { subscriptionTier: "super_grok" },
  );

  assert.equal(parsed.plan, "Super Grok");
  assert.ok(parsed.quotas["On-demand"]);
  assert.equal(parsed.quotas["On-demand"].used, 35);
  assert.equal(parsed.quotas["On-demand"].total, 100);
  assert.equal(parsed.quotas["On-demand"].remainingPercentage, 65);
});

test("parseGrokCliBilling treats cap=0 with no pool as exhausted promo bar", () => {
  const parsed = parseGrokCliBilling({
    config: { onDemandCap: { val: 0 }, onDemandUsed: { val: 0 } },
  });
  assert.equal(parsed.quotas["On-demand"].remainingPercentage, 0);
  assert.equal(parsed.quotas["On-demand"].total, 1);
});

test("getUsageForProvider routes grok-cli (not default unimplemented)", async () => {
  const result = await getUsageForProvider({
    provider: "grok-cli",
    accessToken: null,
  });
  assert.match(result.message || "", /access token/i);
  assert.doesNotMatch(
    result.message || "",
    /not implemented/i,
    "must not fall through to default 'not implemented'",
  );
});

test("merge: format=credits onDemand alone must not hide weekly pool from plain billing", () => {
  // Simulates merging plain /v1/billing + ?format=credits responses
  const plain = {
    config: {
      currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
      used: { val: 2900 },
      monthlyLimit: { val: 10000 },
      billingPeriodEnd: "2026-07-14T15:12:00+00:00",
    },
  };
  const creditsOnly = {
    config: {
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
      prepaidBalance: { val: 0 },
    },
  };
  const merged = {
    config: { ...plain.config, ...creditsOnly.config },
  };
  const parsed = parseGrokCliBilling(merged, { hasGrokCodeAccess: true });
  assert.equal(Math.round(parsed.quotas.Weekly.remainingPercentage), 71);
  assert.equal(parsed.quotas["On-demand"], undefined);
});
