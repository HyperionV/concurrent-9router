import test from "node:test";
import assert from "node:assert/strict";

const {
  DISPATCHER_MODE,
  buildDispatcherModePatch,
  deriveDispatcherMode,
  normalizeDispatcherSlotsPerConnection,
} = await import("../../src/lib/dispatcher/settings.js");

test("deriveDispatcherMode maps settings to explicit operator modes", () => {
  assert.equal(deriveDispatcherMode({}), DISPATCHER_MODE.OFF);
  assert.equal(
    deriveDispatcherMode({ dispatcherShadowMode: true }),
    DISPATCHER_MODE.SHADOW,
  );
  assert.equal(
    deriveDispatcherMode({
      dispatcherEnabled: true,
      dispatcherShadowMode: true,
    }),
    DISPATCHER_MODE.MANAGED,
  );
});

test("buildDispatcherModePatch enforces mutually exclusive mode settings", () => {
  assert.deepEqual(buildDispatcherModePatch(DISPATCHER_MODE.OFF), {
    dispatcherEnabled: false,
    dispatcherShadowMode: false,
  });
  assert.deepEqual(buildDispatcherModePatch(DISPATCHER_MODE.SHADOW), {
    dispatcherEnabled: false,
    dispatcherShadowMode: true,
  });
  assert.deepEqual(buildDispatcherModePatch(DISPATCHER_MODE.MANAGED), {
    dispatcherEnabled: true,
    dispatcherShadowMode: false,
  });
});

test("normalizeDispatcherSlotsPerConnection rejects unsafe values", () => {
  assert.equal(normalizeDispatcherSlotsPerConnection(5), 5);
  assert.throws(
    () => normalizeDispatcherSlotsPerConnection(0),
    /dispatcherSlotsPerConnection must be an integer between 1 and 20/,
  );
  assert.throws(
    () => normalizeDispatcherSlotsPerConnection(100),
    /dispatcherSlotsPerConnection must be an integer between 1 and 20/,
  );
  assert.throws(
    () => normalizeDispatcherSlotsPerConnection(2.5),
    /dispatcherSlotsPerConnection must be an integer between 1 and 20/,
  );
});
