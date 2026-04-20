import test from "node:test";
import assert from "node:assert/strict";

const machineIdModule = await import("../../src/shared/utils/machineId.js");

test("resolveMachineIdSync prefers named export", () => {
  const fn = () => "named";
  assert.equal(
    machineIdModule.resolveMachineIdSync({
      machineIdSync: fn,
      default: { machineIdSync: () => "default" },
    }),
    fn,
  );
});

test("resolveMachineIdSync falls back to default export shape", () => {
  const fn = () => "default";
  assert.equal(
    machineIdModule.resolveMachineIdSync({
      default: { machineIdSync: fn },
    }),
    fn,
  );
});

test("resolveMachineIdSync returns null when export is missing", () => {
  assert.equal(machineIdModule.resolveMachineIdSync(null), null);
  assert.equal(machineIdModule.resolveMachineIdSync({}), null);
});
