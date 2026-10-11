"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const LIVE_INTERVAL_MS = 3000;
const HISTORY_INTERVAL_MS = 20_000;
/** Live data older than this is shown as stale. */
export const LIVE_STALE_AFTER_MS = 10_000;

async function fetchView(provider, view, range, signal) {
  const params = new URLSearchParams({ provider, view, range });
  const response = await fetch(`/api/dispatcher/text/status?${params}`, {
    cache: "no-store",
    signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw new Error(data?.error || `Status request failed (${response.status})`);
  }
  return data;
}

/**
 * Polls the dispatcher status in two independent streams: live (3s) and
 * history (20s, refetched at once when the range changes). Each stream keeps
 * its last good payload when a poll fails, reports the failure, and drops
 * responses that arrive after a newer request was made. Polling pauses while
 * the tab is hidden.
 */
export function useDispatcherStatus(provider, range) {
  const [live, setLive] = useState(null);
  const [history, setHistory] = useState(null);
  const [liveError, setLiveError] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [liveReceivedAt, setLiveReceivedAt] = useState(0);
  const sequence = useRef({ live: 0, history: 0 });

  const loadLive = useCallback(async () => {
    const id = ++sequence.current.live;
    try {
      const data = await fetchView(provider, "live", range);
      if (id !== sequence.current.live) return;
      setLive(data);
      setLiveReceivedAt(Date.now());
      setLiveError(null);
    } catch (error) {
      if (id === sequence.current.live) setLiveError(error.message);
    }
  }, [provider, range]);

  const loadHistory = useCallback(async () => {
    const id = ++sequence.current.history;
    try {
      const data = await fetchView(provider, "history", range);
      if (id !== sequence.current.history) return;
      setHistory(data);
      setHistoryError(null);
    } catch (error) {
      if (id === sequence.current.history) setHistoryError(error.message);
    }
  }, [provider, range]);

  useEffect(() => {
    const timers = [];
    const loadBoth = () => {
      loadLive();
      loadHistory();
    };
    // Load at once (first timer tick), then poll each stream on its cadence.
    const start = () => {
      timers.push(setTimeout(loadBoth, 0));
      timers.push(setInterval(loadLive, LIVE_INTERVAL_MS));
      timers.push(setInterval(loadHistory, HISTORY_INTERVAL_MS));
    };
    const stop = () => timers.splice(0).forEach((timer) => {
      clearTimeout(timer);
      clearInterval(timer);
    });
    const onVisibility = () => {
      stop();
      if (document.visibilityState === "visible") start();
    };
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadLive, loadHistory]);

  const refresh = useCallback(() => {
    loadLive();
    loadHistory();
  }, [loadLive, loadHistory]);

  // A payload for another provider or range (the previous selection, still
  // on screen until the new one arrives) is never shown as the current one.
  const currentLive = live?.provider === provider ? live : null;
  const currentHistory =
    history?.provider === provider && history?.range === range ? history : null;

  return {
    live: currentLive,
    history: currentHistory,
    historyLoading: !currentHistory && !historyError,
    liveError,
    historyError,
    liveReceivedAt,
    refresh,
  };
}

/** Re-renders every `intervalMs` so ages and staleness tick between polls. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
