/**
 * Grok CLI usage parsing — billing?format=credits protobuf-json shape.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseGrokCliBilling, getUsageForProvider } from "./usage.js";

test("parseGrokCliBilling maps on-demand cap/used with {val} wrappers", () => {
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

test("parseGrokCliBilling treats cap=0 as exhausted promo bar", () => {
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
