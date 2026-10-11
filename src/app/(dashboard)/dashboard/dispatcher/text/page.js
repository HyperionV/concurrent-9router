"use client";

import { useEffect, useState } from "react";
import { AI_PROVIDERS } from "@/shared/constants/providers";
import { TEXT_DISPATCH_PROVIDERS } from "@/lib/dispatcher/settings";
import "./dispatcher.css";

import { useDispatcherStatus, useNow } from "./useDispatcherStatus";
import StatusBar from "./components/StatusBar";
import KpiStrip from "./components/KpiStrip";
import TrendPanel from "./components/TrendPanel";
import ModelTable from "./components/ModelTable";
import AccountTable from "./components/AccountTable";
import LiveTape from "./components/LiveTape";
import DiagnosticsPanel from "./components/DiagnosticsPanel";
import DispatcherControlsCard from "./components/DispatcherControlsCard";

/**
 * The dedicated text pools, plus any other provider that has accounts,
 * labelled with the provider's name (custom provider nodes by their node name).
 */
function useProviderOptions() {
  const [options, setOptions] = useState(() =>
    TEXT_DISPATCH_PROVIDERS.map((id) => ({ id, label: AI_PROVIDERS[id]?.name || id })),
  );
  useEffect(() => {
    let cancelled = false;
    const load = (url) => fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : {}));
    Promise.all([load("/api/providers"), load("/api/provider-nodes")])
      .then(([providerData, nodeData]) => {
        if (cancelled) return;
        const nodeNames = new Map((nodeData.nodes || []).map((node) => [node.id, node.name]));
        const ids = new Set([
          ...TEXT_DISPATCH_PROVIDERS,
          ...(providerData.connections || []).map((c) => c.provider),
        ]);
        setOptions(
          [...ids].map((id) => ({ id, label: AI_PROVIDERS[id]?.name || nodeNames.get(id) || id })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}

function ErrorNote({ children }) {
  return (
    <div className="dispatcher-panel px-4 py-2.5 text-xs" style={{ borderColor: "var(--status-critical)" }} role="alert">
      <span style={{ color: "var(--status-critical)" }}>●</span>{" "}
      <span className="text-text-main">{children}</span>
    </div>
  );
}

export default function DispatcherPage() {
  const [provider, setProvider] = useState("codex");
  const [range, setRange] = useState("24h");
  const providers = useProviderOptions();
  const currentLabel = providers.find((p) => p.id === provider)?.label || provider;
  const now = useNow();
  const { live, history, liveError, historyError, liveReceivedAt, historyLoading, refresh } =
    useDispatcherStatus(provider, range);
  const h = history?.history;
  const l = live?.live;

  return (
    <div className="dispatcher-console flex flex-col gap-4">
      <StatusBar
        providers={providers}
        provider={provider}
        onProviderChange={setProvider}
        range={range}
        onRangeChange={setRange}
        mode={live?.mode || history?.mode}
        liveReceivedAt={liveReceivedAt}
        liveError={liveError}
        historyLoading={historyLoading}
        onRefresh={refresh}
        now={now}
      />

      {historyError && (
        <ErrorNote>
          History could not be loaded ({historyError}).{h ? " Showing the last good data." : ""}
        </ErrorNote>
      )}

      <KpiStrip history={h} live={l} range={range} now={now} />

      <TrendPanel timeline={h?.timeline || []} range={range} loading={historyLoading} />

      <AccountTable occupancy={l?.occupancy || []} accounts={h?.accounts} range={range} now={now} />

      <ModelTable
        models={h?.models || []}
        liveActive={l?.active.byModel || {}}
        liveQueued={l?.queue.byModel || {}}
        range={range}
      />

      <LiveTape live={l} liveReceivedAt={liveReceivedAt} now={now} />

      <DiagnosticsPanel
        diagnostics={h?.diagnostics}
        timeoutPolicy={live?.timeoutPolicy || history?.timeoutPolicy}
        now={now}
      />

      <DispatcherControlsCard
        // Remount per provider and once settings arrive, so the form starts
        // from the saved values instead of syncing them in an effect.
        key={`${provider}:${live?.settings || history?.settings ? "ready" : "loading"}`}
        settings={live?.settings || history?.settings}
        provider={provider}
        providerLabel={currentLabel}
        onRefresh={refresh}
      />
    </div>
  );
}
