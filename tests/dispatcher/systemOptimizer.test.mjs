import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateOptimizationSavings,
  runSystemOptimization,
} from "../../src/lib/system/systemOptimizer.js";

test("estimateOptimizationSavings returns structured numeric metrics", () => {
  const estimates = estimateOptimizationSavings();

  assert.ok(estimates, "Estimates object should exist");
  assert.equal(typeof estimates.walBytes, "number", "WAL bytes should be numeric");
  assert.equal(typeof estimates.freelistBytes, "number", "Freelist bytes should be numeric");
  assert.equal(
    typeof estimates.estimatedReclaimableBytes,
    "number",
    "Reclaimable bytes should be numeric"
  );
  assert.equal(
    typeof estimates.candidatePruneCount,
    "number",
    "Candidate prune count should be numeric"
  );
});

test("runSystemOptimization executes successfully and produces structured audit delta", async () => {
  const audit = await runSystemOptimization({ retentionDays: 7 });

  assert.ok(audit, "Audit result must exist");
  assert.ok(audit.durationMs >= 0, "Duration must be positive or 0");

  // Database audit
  assert.ok(audit.database, "Database audit section must exist");
  assert.equal(typeof audit.database.prunedAttempts, "number");
  assert.equal(typeof audit.database.prunedAffinities, "number");
  assert.equal(typeof audit.database.totalPruned, "number");
  assert.ok(["TRUNCATE", "PASSIVE", "none"].includes(audit.database.checkpointMode));
  assert.equal(typeof audit.database.optimized, "boolean");

  // Memory audit
  assert.ok(audit.memory, "Memory audit section must exist");
  assert.ok(audit.memory.rssBytesBefore > 0);
  assert.ok(audit.memory.heapBytesBefore > 0);
  assert.equal(typeof audit.memory.rssBytesFreed, "number");
  assert.equal(typeof audit.memory.heapBytesFreed, "number");
  assert.equal(typeof audit.memory.gcExecuted, "boolean");

  // Caches audit
  assert.ok(audit.caches, "Caches section must exist");
  assert.equal(audit.caches.cleared, true);
});
