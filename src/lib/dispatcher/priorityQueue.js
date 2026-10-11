/**
 * Priority classes for queued requests: who gets the next free slot, how many
 * slots background work may hold, and how long each class may wait.
 *
 * Clients send `x-brae-priority: interactive` for work a person is waiting on
 * (Manager chat). Everything else, including requests without the header, is
 * `batch`. No request is rejected for lack of capacity: it waits until a slot
 * frees, its client leaves, or its class's waiting limit passes.
 *
 * Tunable through environment variables; DISPATCHER_BATCH_SHARE=1 turns the
 * two classes back into one first-come-first-served queue.
 */

export const PRIORITY_CLASS = Object.freeze({
  INTERACTIVE: "interactive",
  BATCH: "batch",
});

export const PRIORITY_HEADER = "x-brae-priority";

function numberFromEnv(name, fallback, { min, max }) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

/** Share of a provider's slots that batch work may hold at once. */
export const BATCH_SHARE = numberFromEnv("DISPATCHER_BATCH_SHARE", 0.8, { min: 0.1, max: 1 });
/** How long a request may wait for a slot, by class. */
export const INTERACTIVE_WAIT_MS = numberFromEnv(
  "DISPATCHER_INTERACTIVE_WAIT_MS",
  2 * 60 * 1000,
  { min: 1000, max: 60 * 60 * 1000 },
);
export const BATCH_WAIT_MS = numberFromEnv("DISPATCHER_BATCH_WAIT_MS", 30 * 60 * 1000, {
  min: 1000,
  max: 6 * 60 * 60 * 1000,
});
/** Safety valve: beyond this many queued requests a provider answers 503. */
export const MAX_QUEUED_PER_PROVIDER = numberFromEnv("DISPATCHER_MAX_QUEUED", 500, {
  min: 1,
  max: 100_000,
});

export function priorityClassFromHeader(value) {
  return String(value || "").trim().toLowerCase() === PRIORITY_CLASS.INTERACTIVE
    ? PRIORITY_CLASS.INTERACTIVE
    : PRIORITY_CLASS.BATCH;
}

export function priorityClassOf(request) {
  return request?.metadata?.priorityClass === PRIORITY_CLASS.INTERACTIVE
    ? PRIORITY_CLASS.INTERACTIVE
    : PRIORITY_CLASS.BATCH;
}

export function queueWaitLimitMs(request) {
  return priorityClassOf(request) === PRIORITY_CLASS.INTERACTIVE
    ? INTERACTIVE_WAIT_MS
    : BATCH_WAIT_MS;
}

/**
 * Most slots batch work may hold across a provider; at least one. Rounded,
 * so a pool of one or two slots keeps no reserve (it would halve batch
 * throughput) and a pool of 30 keeps 6 for interactive work.
 */
export function batchSlotCeiling(totalSlots) {
  return Math.max(1, Math.round(BATCH_SHARE * totalSlots));
}
