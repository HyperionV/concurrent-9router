"use client";

import DataTable from "./DataTable";
import SuccessRate from "./SuccessRate";
import {
  RANGE_LABELS,
  formatAge,
  formatAtMost,
  formatCount,
  formatPercent,
  shortId,
} from "../format";

const RECENTLY_ACTIVE_MS = 60_000;

function SlotMeter({ occupied, capacity }) {
  const ratio = capacity > 0 ? Math.min(1, occupied / capacity) : 0;
  const color = ratio >= 1 ? "var(--status-critical)" : ratio >= 0.6 ? "var(--status-warning)" : "var(--color-primary)";
  return (
    <span className="inline-flex items-center gap-2" title={`${occupied} of ${capacity} slots in use`}>
      <span className="meter h-1.5 w-12 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
        <span className="block h-full rounded-full" style={{ width: `${ratio * 100}%`, background: color }} />
      </span>
      <span className="text-text-main">{occupied}/{capacity}</span>
    </span>
  );
}

function ModelMix({ account }) {
  const total = Math.max(1, ...account.models.map((m) => m.totalTokens));
  if (account.models.length === 0) {
    return <span className="text-[11px] text-text-muted">No provider traffic in this range.</span>;
  }
  return (
    <div className="grid gap-1 sm:grid-cols-2">
      {account.models.map((m) => (
        <div key={m.modelId} className="num flex items-center gap-2 text-[11px]">
          <span className="w-40 truncate text-text-main" title={m.modelId}>{m.modelId}</span>
          <span className="meter h-1 flex-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
            <span className="block h-full rounded-full bg-[var(--viz-1)]" style={{ width: `${(m.totalTokens / total) * 100}%` }} />
          </span>
          <span className="w-28 text-right text-text-muted">
            {formatCount(m.totalTokens)} tok · {formatCount(m.requests)} req
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Every account in the pool: live slot use joined with the range's
 * statistics. Accounts appear even with no traffic, so an idle account is
 * visible rather than missing.
 */
export default function AccountTable({ occupancy, accounts, range, now }) {
  const rows = occupancy.map((slot) => ({
    ...slot,
    stats: accounts?.[slot.connectionId] || null,
  }));
  const isActive = (row) =>
    row.occupiedSlots > 0 ||
    (row.stats?.lastActiveAt && now - new Date(row.stats.lastActiveAt).getTime() < RECENTLY_ACTIVE_MS);

  const columns = [
    {
      key: "account",
      label: "Account",
      sortValue: (r) => r.connectionName.toLowerCase(),
      render: (r) => (
        <span className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive(r) ? "pulse" : ""}`}
            style={{ background: isActive(r) ? "var(--status-good)" : "var(--status-neutral)" }}
            aria-label={isActive(r) ? "active" : "idle"}
          />
          <span className="max-w-[180px] truncate font-medium text-text-main" title={r.connectionName}>{r.connectionName}</span>
          <span className="hidden text-[10px] text-text-muted lg:inline" title={r.connectionId}>{shortId(r.connectionId, 8)}</span>
        </span>
      ),
    },
    { key: "slots", label: "Slots", sortValue: (r) => r.occupiedSlots / Math.max(1, r.capacity), render: (r) => <SlotMeter occupied={r.occupiedSlots} capacity={r.capacity} /> },
    { key: "attempts", label: "Attempts", align: "right", sortValue: (r) => r.stats?.dispatch.attempts ?? 0, render: (r) => <span className="text-text-main">{formatCount(r.stats?.dispatch.attempts ?? 0)}</span> },
    { key: "success", label: "Success", align: "right", sortValue: (r) => r.stats?.dispatch.successRate ?? null, render: (r) => (r.stats ? <SuccessRate dispatch={r.stats.dispatch} /> : "—") },
    { key: "ttft", label: "TTFT p95", align: "right", sortValue: (r) => r.stats?.dispatch.ttft.p95Ms ?? null, render: (r) => <span className="text-text-main">{formatAtMost(r.stats?.dispatch.ttft.p95Ms)}</span> },
    { key: "tokens", label: "Tokens", align: "right", sortValue: (r) => r.stats?.traffic.totalTokens ?? 0, render: (r) => <span className="text-text-main">{formatCount(r.stats?.traffic.totalTokens ?? 0)}</span> },
    { key: "cache", label: "Cache hit", align: "right", sortValue: (r) => r.stats?.traffic.cacheHitRate ?? null, render: (r) => <span className="text-text-muted">{formatPercent(r.stats?.traffic.cacheHitRate, 0)}</span> },
    {
      key: "last",
      label: "Last active",
      align: "right",
      sortValue: (r) => (r.stats?.lastActiveAt ? new Date(r.stats.lastActiveAt).getTime() : null),
      render: (r) => (
        <span className="text-text-muted" title={r.stats?.lastActiveAt || "no recorded activity"}>
          {formatAge(r.stats?.lastActiveAt, now)}
        </span>
      ),
    },
  ];

  return (
    <section className="dispatcher-panel p-4" aria-label="Accounts">
      <header className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-text-main">
          Accounts <span className="num font-normal text-text-muted">{rows.length}</span>
        </h3>
        <span className="text-[11px] text-text-muted">slots live · stats {RANGE_LABELS[range]} · click a row for its models</span>
      </header>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.connectionId}
        defaultSort="attempts"
        renderExpanded={(r) => (r.stats ? <ModelMix account={r.stats} /> : null)}
        empty="No accounts in this pool"
      />
    </section>
  );
}
