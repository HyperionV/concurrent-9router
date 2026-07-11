import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir.js";
import {
  insertDispatchAttemptEvent,
  listActiveDispatchAttempts,
  transitionDispatchAttempt,
  updateDispatchRequestStatus,
} from "@/lib/sqlite/dispatcherStore.js";
import { nowIso } from "@/lib/sqlite/helpers.js";
import {
  DEFAULT_TERMINAL_REASON,
  DISPATCH_ATTEMPT_STATE,
  DISPATCH_EVENT_TYPE,
  DISPATCH_REQUEST_STATUS,
} from "@/lib/dispatcher/types.js";
import { TEXT_DISPATCH_PROVIDERS } from "@/lib/dispatcher/settings.js";

/**
 * Once per Node process: clear active dispatch attempts left by a previous
 * process. Uses process.env + a small flag file so multiple Next route module
 * graphs in the same process share one clean (they must not each wipe live work).
 *
 * Does NOT run again for the same process instance — safe when chat + dashboard
 * load separate bundles.
 */
export function clearZombieAttemptsOnProcessBoot() {
  const instanceId = (process.env.DISPATCHER_INSTANCE_ID ||=
    `${process.pid}-${Date.now()}`);
  const flagPath = path.join(DATA_DIR, ".dispatcher-instance");

  try {
    if (fs.existsSync(flagPath)) {
      const prev = fs.readFileSync(flagPath, "utf8").trim();
      if (prev === instanceId) return;
    }
  } catch {
    // fall through and clean
  }

  let total = 0;
  for (const provider of TEXT_DISPATCH_PROVIDERS) {
    for (const attempt of listActiveDispatchAttempts(provider)) {
      if (!attempt?.id) continue;
      const updated = transitionDispatchAttempt(
        attempt.id,
        [
          DISPATCH_ATTEMPT_STATE.LEASED,
          DISPATCH_ATTEMPT_STATE.CONNECTING,
          DISPATCH_ATTEMPT_STATE.STREAMING,
        ],
        DISPATCH_ATTEMPT_STATE.RECONCILED,
        {
          finishedAt: nowIso(),
          terminalReason: DEFAULT_TERMINAL_REASON.RECONCILED,
          error: {
            code: "process_boot_clean",
            message:
              "Active attempt from a previous process; cleared so new traffic can lease",
          },
        },
      );
      if (!updated) continue;
      total += 1;
      insertDispatchAttemptEvent({
        id: randomUUID(),
        attemptId: attempt.id,
        eventType: DISPATCH_EVENT_TYPE.RECONCILED,
        payload: { reason: "process_boot_clean" },
      });
      if (attempt.requestId) {
        updateDispatchRequestStatus(
          attempt.requestId,
          DISPATCH_REQUEST_STATUS.CANCELLED,
          { completedAt: nowIso() },
        );
      }
    }
  }

  if (total > 0) {
    console.log(
      `[DISPATCHER] process boot: cleared ${total} zombie active attempt(s) from a prior run`,
    );
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(flagPath, instanceId, "utf8");
  } catch (error) {
    console.warn(
      "[DISPATCHER] could not write dispatcher instance flag:",
      error?.message || error,
    );
  }
}
