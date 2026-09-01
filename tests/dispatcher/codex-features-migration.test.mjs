import test from "node:test";
import assert from "node:assert/strict";

import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

test("parseQuotaData correctly normalizes standard, review, and spark quota windows", () => {
  const mockCodexUsage = {
    plan: "team",
    quotas: {
      session: { used: 20, total: 100, remaining: 80, resetAt: "2026-08-22T05:00:00.000Z" },
      weekly: { used: 40, total: 100, remaining: 60, resetAt: "2026-08-28T05:00:00.000Z" },
      review_session: { used: 5, total: 100, remaining: 95, resetAt: "2026-08-22T05:00:00.000Z" },
      review_weekly: { used: 10, total: 100, remaining: 90, resetAt: "2026-08-28T05:00:00.000Z" },
      spark_session: { used: 12, total: 100, remaining: 88, resetAt: "2026-08-22T05:00:00.000Z" },
      spark_weekly: { used: 25, total: 100, remaining: 75, resetAt: "2026-08-28T05:00:00.000Z" },
    },
  };

  const parsed = parseQuotaData("codex", mockCodexUsage);

  const sparkSession = parsed.find((q) => q.name === "Spark (5h)");
  const sparkWeekly = parsed.find((q) => q.name === "Spark (Weekly)");
  const session = parsed.find((q) => q.name === "5h");
  const weekly = parsed.find((q) => q.name === "Weekly");
  const reviewSession = parsed.find((q) => q.name === "Review (5h)");
  const reviewWeekly = parsed.find((q) => q.name === "Review (Weekly)");

  assert.ok(sparkSession, "Spark (5h) should be defined");
  assert.equal(sparkSession.used, 12);
  assert.equal(sparkSession.remaining, 88);

  assert.ok(sparkWeekly, "Spark (Weekly) should be defined");
  assert.equal(sparkWeekly.used, 25);
  assert.equal(sparkWeekly.remaining, 75);

  assert.ok(session, "5h should be defined");
  assert.equal(session.used, 20);
  assert.equal(session.remaining, 80);

  assert.ok(weekly, "Weekly should be defined");
  assert.equal(weekly.used, 40);
  assert.equal(weekly.remaining, 60);

  assert.ok(reviewSession, "Review (5h) should be defined");
  assert.equal(reviewSession.used, 5);

  assert.ok(reviewWeekly, "Review (Weekly) should be defined");
  assert.equal(reviewWeekly.used, 10);
});

test("CodexExecutor handles GPT-5.6 Sol / Terra ultra reasoning level override", () => {
  const executor = new CodexExecutor();

  const reqSol = executor.buildRequest({
    model: "gpt-5.6-sol-ultra",
    body: { input: "Hello" },
    credentials: { connectionId: "conn-1" },
  });
  assert.equal(reqSol.transformedBody.model, "gpt-5.6-sol");
  assert.equal(reqSol.transformedBody.reasoning.effort, "ultra");

  const reqTerra = executor.buildRequest({
    model: "gpt-5.6-terra-ultra",
    body: { input: "Hello" },
    credentials: { connectionId: "conn-1" },
  });
  assert.equal(reqTerra.transformedBody.model, "gpt-5.6-terra");
  assert.equal(reqTerra.transformedBody.reasoning.effort, "ultra");
});

test("CodexExecutor normalizes Luna ultra to max and standard codex ultra/max to xhigh", () => {
  const executor = new CodexExecutor();

  const reqLuna = executor.buildRequest({
    model: "gpt-5.6-luna-ultra",
    body: { input: "Hello" },
    credentials: { connectionId: "conn-1" },
  });
  assert.equal(reqLuna.transformedBody.model, "gpt-5.6-luna");
  assert.equal(reqLuna.transformedBody.reasoning.effort, "max");

  const reqStandardMax = executor.buildRequest({
    model: "gpt-5.3-codex-max",
    body: { input: "Hello" },
    credentials: { connectionId: "conn-1" },
  });
  assert.equal(reqStandardMax.transformedBody.model, "gpt-5.3-codex");
  assert.equal(reqStandardMax.transformedBody.reasoning.effort, "xhigh");

  const reqStandardUltra = executor.buildRequest({
    model: "gpt-5.3-codex-ultra",
    body: { input: "Hello" },
    credentials: { connectionId: "conn-1" },
  });
  assert.equal(reqStandardUltra.transformedBody.model, "gpt-5.3-codex");
  assert.equal(reqStandardUltra.transformedBody.reasoning.effort, "xhigh");
});
