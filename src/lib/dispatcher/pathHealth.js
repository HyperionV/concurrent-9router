const DEFAULT_PATH_SCORE = 100;
const DEGRADED_PATH_PENALTY = 25;
const FAILED_PATH_PENALTY = 60;
const MAX_SCORE = 100;
const MIN_SCORE = 0;

function clampScore(score) {
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));
}

function pathKey(connectionId, pathMode) {
  return `${connectionId || "unknown"}::${pathMode || "unknown"}`;
}

export function createPathHealthTracker() {
  const scores = new Map();

  function getPathScore(connectionId, pathMode = "default") {
    const key = pathKey(connectionId, pathMode);
    return scores.get(key) ?? DEFAULT_PATH_SCORE;
  }

  function recordPathOutcome(connectionId, pathMode, outcome = "success") {
    const key = pathKey(connectionId, pathMode);
    const current = getPathScore(connectionId, pathMode);
    let next = current;
    if (outcome === "proxy_failed_direct_fallback" || outcome === "degraded") {
      next = current - DEGRADED_PATH_PENALTY;
    } else if (outcome === "failed") {
      next = current - FAILED_PATH_PENALTY;
    } else if (outcome === "success") {
      next = current + 10;
    }
    scores.set(key, clampScore(next));
    return scores.get(key);
  }

  function rankConnection(connection, occupancy = 0) {
    const baseScore = getPathScore(
      connection?.id,
      connection?.pathMode || "default",
    );
    const priority = Number(connection?.priority ?? 999);
    return baseScore - occupancy * 10 - priority;
  }

  function snapshot() {
    return Object.fromEntries(scores.entries());
  }

  return {
    getPathScore,
    recordPathOutcome,
    rankConnection,
    snapshot,
  };
}
