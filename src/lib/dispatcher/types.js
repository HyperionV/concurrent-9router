export const DISPATCH_REQUEST_STATUS = {
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
};

export const DISPATCH_ATTEMPT_STATE = {
  QUEUED: "queued",
  LEASED: "leased",
  CONNECTING: "connecting",
  STREAMING: "streaming",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
  RECONCILED: "reconciled",
};

export const DISPATCH_TIMEOUT_KIND = {
  QUEUE_EXPIRED: "queue_expired",
  CONNECT_TIMEOUT: "connect_timeout",
  TTFT_TIMEOUT: "ttft_timeout",
  IDLE_TIMEOUT: "idle_timeout",
  ATTEMPT_DEADLINE: "attempt_deadline",
};

export const DISPATCH_EVENT_TYPE = {
  ENQUEUED: "enqueued",
  LEASED: "leased",
  CONNECT_STARTED: "connect_started",
  STREAM_STARTED: "stream_started",
  FIRST_PROGRESS: "first_progress",
  LAST_PROGRESS: "last_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  TIMED_OUT: "timed_out",
  CANCELLED: "cancelled",
  RECONCILED: "reconciled",
};

export const TERMINAL_ATTEMPT_STATES = new Set([
  DISPATCH_ATTEMPT_STATE.COMPLETED,
  DISPATCH_ATTEMPT_STATE.FAILED,
  DISPATCH_ATTEMPT_STATE.TIMED_OUT,
  DISPATCH_ATTEMPT_STATE.CANCELLED,
  DISPATCH_ATTEMPT_STATE.RECONCILED,
]);

export const ACTIVE_ATTEMPT_STATES = new Set([
  DISPATCH_ATTEMPT_STATE.LEASED,
  DISPATCH_ATTEMPT_STATE.CONNECTING,
  DISPATCH_ATTEMPT_STATE.STREAMING,
]);

export const DEFAULT_TERMINAL_REASON = {
  SUCCESS: "success",
  ERROR: "error",
  CANCELLED: "cancelled",
  TIMEOUT: "timeout",
  RECONCILED: "reconciled",
};
