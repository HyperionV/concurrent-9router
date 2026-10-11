"use client";

import DataTable from "./DataTable";
import SuccessRate from "./SuccessRate";
import { RANGE_LABELS, formatAtMost, formatCount, formatPercent } from "../format";

export default function ModelTable({ models, liveActive, liveQueued, range }) {
  const maxAttempts = Math.max(1, ...models.map((m) => m.dispatch.attempts));
  const columns = [
    {
      key: "model",
      label: "Model",
      sortValue: (m) => m.modelId,
      render: (m) => (
        <span className="flex items-center gap-2">
          <span className="font-medium text-text-main">{m.modelId}</span>
          {liveActive[m.modelId] > 0 && (
            <span className="rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
              {liveActive[m.modelId]} running
            </span>
          )}
          {liveQueued[m.modelId] > 0 && (
            <span className="rounded px-1.5 py-px text-[10px] font-medium" style={{ color: "var(--status-warning)", background: "var(--panel-inset)" }}>
              {liveQueued[m.modelId]} queued
            </span>
          )}
        </span>
      ),
    },
    {
      key: "attempts",
      label: "Attempts",
      align: "right",
      sortValue: (m) => m.dispatch.attempts,
      render: (m) => (
        <span className="inline-flex items-center gap-2">
          <span className="meter hidden h-1 w-14 overflow-hidden rounded-full bg-black/[0.06] sm:block dark:bg-white/[0.08]">
            <span className="block h-full rounded-full bg-primary/70" style={{ width: `${(m.dispatch.attempts / maxAttempts) * 100}%` }} />
          </span>
          <span className="text-text-main">{formatCount(m.dispatch.attempts)}</span>
        </span>
      ),
    },
    { key: "success", label: "Success", align: "right", sortValue: (m) => m.dispatch.successRate, render: (m) => <SuccessRate dispatch={m.dispatch} /> },
    { key: "ttft50", label: "TTFT p50", align: "right", sortValue: (m) => m.dispatch.ttft.p50Ms, render: (m) => <span className="text-text-muted">{formatAtMost(m.dispatch.ttft.p50Ms)}</span> },
    { key: "ttft95", label: "TTFT p95", align: "right", sortValue: (m) => m.dispatch.ttft.p95Ms, render: (m) => <span className="text-text-main">{formatAtMost(m.dispatch.ttft.p95Ms)}</span> },
    { key: "queue", label: "Queue p95", align: "right", sortValue: (m) => m.dispatch.queueWait.p95Ms, render: (m) => <span className="text-text-muted">{formatAtMost(m.dispatch.queueWait.p95Ms)}</span> },
    { key: "requests", label: "Requests", align: "right", title: "All provider requests for this model, routed by the dispatcher or not", sortValue: (m) => m.traffic.requests, render: (m) => <span className="text-text-muted">{formatCount(m.traffic.requests)}</span> },
    { key: "tokens", label: "Tokens", align: "right", sortValue: (m) => m.traffic.totalTokens, render: (m) => <span className="text-text-main">{formatCount(m.traffic.totalTokens)}</span> },
    { key: "cache", label: "Cache hit", align: "right", sortValue: (m) => m.traffic.cacheHitRate, render: (m) => <span className="text-text-muted">{formatPercent(m.traffic.cacheHitRate, 0)}</span> },
  ];

  return (
    <section className="dispatcher-panel p-4" aria-label="Models">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-text-main">Models</h3>
        <span className="text-[11px] text-text-muted">{RANGE_LABELS[range]}</span>
      </header>
      <DataTable
        columns={columns}
        rows={models}
        rowKey={(m) => m.modelId}
        defaultSort="attempts"
        empty="No model traffic in this range"
      />
    </section>
  );
}
