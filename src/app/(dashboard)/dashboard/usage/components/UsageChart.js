"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import Card from "@/shared/components/Card";

const fmtTokens = (n) => {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n || 0);
};

const fmtCost = (n) => `$${(n || 0).toFixed(4)}`;

const STEPS = [
  { value: "hour", label: "Hourly" },
  { value: "day", label: "Daily" },
  { value: "custom", label: "Custom" },
];

export default function UsageChart({ query = "period=7d" }) {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [viewMode, setViewMode] = useState("tokens");
  const [step, setStep] = useState("day");
  const [customStep, setCustomStep] = useState({ size: "6", unit: "hour" });

  const fetchData = useCallback(
    async (signal) => {
      setLoading(true);
      try {
        const params = new URLSearchParams(query);
        params.set("step", step);
        if (step === "custom") {
          params.set("stepSize", customStep.size);
          params.set("stepUnit", customStep.unit);
        }
        const res = await fetch(`/api/usage/chart?${params.toString()}`, {
          signal,
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          if (!signal.aborted) {
            setData([]);
            setError(json?.error || "Failed to fetch chart data");
          }
          return;
        }
        if (!signal.aborted) {
          setError(null);
          setData(json);
        }
      } catch (e) {
        if (e?.name !== "AbortError")
          console.error("Failed to fetch chart data:", e);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [query, step, customStep.size, customStep.unit],
  );

  useEffect(() => {
    const controller = new AbortController();
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const hasData = data.some((d) => d.tokens > 0 || d.cost > 0);

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 bg-bg-subtle rounded-lg p-1 border border-border">
          <button
            onClick={() => setViewMode("tokens")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "tokens" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Tokens
          </button>
          <button
            onClick={() => setViewMode("cost")}
            className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${viewMode === "cost" ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
          >
            Cost
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {step === "custom" && (
            <div className="flex items-center gap-1 rounded-lg border border-border bg-bg-subtle p-1 text-xs text-text-muted">
              <span className="px-1">Every</span>
              <input
                type="number"
                min="1"
                max="365"
                value={customStep.size}
                onChange={(e) =>
                  setCustomStep((current) => ({
                    ...current,
                    size: e.target.value,
                  }))
                }
                className="w-16 rounded-md border border-border bg-bg px-2 py-1 text-text outline-none focus:ring-2 focus:ring-primary/40"
              />
              <select
                value={customStep.unit}
                onChange={(e) =>
                  setCustomStep((current) => ({
                    ...current,
                    unit: e.target.value,
                  }))
                }
                className="rounded-md border border-border bg-bg px-2 py-1 text-text outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="hour">hours</option>
                <option value="day">days</option>
              </select>
            </div>
          )}
          <div className="flex items-center gap-1 bg-bg-subtle rounded-lg p-1 border border-border">
            {STEPS.map((option) => (
              <button
                key={option.value}
                onClick={() => setStep(option.value)}
                className={`px-3 py-1 rounded-md text-sm font-medium transition-colors ${step === option.value ? "bg-primary text-white shadow-sm" : "text-text-muted hover:text-text hover:bg-bg-hover"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">
          Loading...
        </div>
      ) : error ? (
        <div className="h-48 flex items-center justify-center text-danger text-sm">
          {error}
        </div>
      ) : !hasData ? (
        <div className="h-48 flex items-center justify-center text-text-muted text-sm">
          No data for this period
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart
            data={data}
            margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id="gradTokens" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="gradCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" strokeOpacity={0.1} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 10, fill: "currentColor", fillOpacity: 0.5 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={viewMode === "tokens" ? fmtTokens : fmtCost}
              width={50}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "var(--color-bg)",
                border: "1px solid var(--color-border)",
                borderRadius: "8px",
                fontSize: "12px",
              }}
              formatter={(value, name) =>
                name === "tokens"
                  ? [fmtTokens(value), "Tokens"]
                  : [fmtCost(value), "Cost"]
              }
            />
            {viewMode === "tokens" ? (
              <Area
                type="monotone"
                dataKey="tokens"
                stroke="#6366f1"
                strokeWidth={2}
                fill="url(#gradTokens)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            ) : (
              <Area
                type="monotone"
                dataKey="cost"
                stroke="#f59e0b"
                strokeWidth={2}
                fill="url(#gradCost)"
                dot={false}
                activeDot={{ r: 4 }}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

UsageChart.propTypes = {
  query: PropTypes.string,
};
