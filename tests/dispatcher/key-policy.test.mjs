import test from "node:test";
import assert from "node:assert/strict";

import {
  computeCodexAdmissionDecision,
  normalizeCodexAdmissionPolicyOverride,
} from "@/lib/dispatcher/admissionPolicy.js";

test("coding override stays legacy under managed runtime", () => {
  const decision = computeCodexAdmissionDecision({
    runtimeMode: "managed",
    defaultPolicy: "legacy",
    apiKeyRecord: {
      id: "key-coding",
      isActive: true,
      codexAdmissionPolicyOverride: "legacy",
    },
  });

  assert.equal(decision.requestedPolicy, "legacy");
  assert.equal(decision.policySource, "key_override");
  assert.equal(decision.effectiveBehavior, "legacy");
  assert.equal(decision.shadowTracked, false);
});

test("production override becomes managed under managed runtime", () => {
  const decision = computeCodexAdmissionDecision({
    runtimeMode: "managed",
    defaultPolicy: "legacy",
    apiKeyRecord: {
      id: "key-prod",
      isActive: true,
      codexAdmissionPolicyOverride: "managed",
    },
  });

  assert.equal(decision.requestedPolicy, "managed");
  assert.equal(decision.policySource, "key_override");
  assert.equal(decision.effectiveBehavior, "managed");
  assert.equal(decision.shadowTracked, false);
});

test("runtime off forces production keys back to legacy", () => {
  const decision = computeCodexAdmissionDecision({
    runtimeMode: "off",
    defaultPolicy: "managed",
    apiKeyRecord: {
      id: "key-prod",
      isActive: true,
      codexAdmissionPolicyOverride: "managed",
    },
  });

  assert.equal(decision.requestedPolicy, "managed");
  assert.equal(decision.effectiveBehavior, "legacy");
  assert.equal(decision.runtimeMode, "off");
});

test("shadow runtime tracks managed policy without changing execution path", () => {
  const decision = computeCodexAdmissionDecision({
    runtimeMode: "shadow",
    defaultPolicy: "managed",
    apiKeyRecord: null,
  });

  assert.equal(decision.policySource, "global_default");
  assert.equal(decision.requestedPolicy, "managed");
  assert.equal(decision.effectiveBehavior, "legacy");
  assert.equal(decision.shadowTracked, true);
});

test("missing key with auth optional inherits global default policy", () => {
  const decision = computeCodexAdmissionDecision({
    runtimeMode: "managed",
    defaultPolicy: "managed",
    apiKeyRecord: null,
  });

  assert.equal(decision.requestedPolicy, "managed");
  assert.equal(decision.policySource, "global_default");
  assert.equal(decision.effectiveBehavior, "managed");
});

test("paused keys are rejected before policy resolution", () => {
  assert.throws(
    () =>
      computeCodexAdmissionDecision({
        runtimeMode: "managed",
        defaultPolicy: "managed",
        apiKeyRecord: {
          id: "key-paused",
          isActive: false,
          codexAdmissionPolicyOverride: "managed",
        },
      }),
    /inactive api key/i,
  );
});

test("policy override normalization accepts only supported values", () => {
  assert.equal(normalizeCodexAdmissionPolicyOverride(undefined), null);
  assert.equal(normalizeCodexAdmissionPolicyOverride(null), null);
  assert.equal(normalizeCodexAdmissionPolicyOverride("inherit"), null);
  assert.equal(normalizeCodexAdmissionPolicyOverride("legacy"), "legacy");
  assert.equal(normalizeCodexAdmissionPolicyOverride("managed"), "managed");
  assert.throws(
    () => normalizeCodexAdmissionPolicyOverride("shadow"),
    /unsupported codex admission policy/i,
  );
});
