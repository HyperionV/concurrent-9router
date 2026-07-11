"use client";

import { cn } from "@/shared/utils/cn";
import { formatResetTime } from "./utils";

// Calculate color based on remaining percentage
const getColorClasses = (remainingPercentage) => {
  if (remainingPercentage > 70) {
    return {
      text: "text-green-500",
      bg: "bg-green-500",
      bgLight: "bg-green-500/10",
      emoji: "🟢"
    };
  }
  
  if (remainingPercentage >= 30) {
    return {
      text: "text-yellow-500",
      bg: "bg-yellow-500",
      bgLight: "bg-yellow-500/10",
      emoji: "🟡"
    };
  }
  
  // 0-29% including 0% (out of quota) - show red
  return {
    text: "text-red-500",
    bg: "bg-red-500",
    bgLight: "bg-red-500/10",
    emoji: "🔴"
  };
};

// Format reset time display
const formatResetTimeDisplay = (resetTime) => {
  if (!resetTime) return null;
  
  try {
    const resetDate = new Date(resetTime);
    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();
    const isTomorrow = resetDate.toDateString() === new Date(now.getTime() + 86400000).toDateString();
    
    const timeStr = resetDate.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    
    if (isToday) return `Today, ${timeStr}`;
    if (isTomorrow) return `Tomorrow, ${timeStr}`;
    
    return resetDate.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return null;
  }
};

function formatQuotaAmount(used, total, unit) {
  if (unit === "percent") {
    return `${Math.round(used)}% of weekly limit used`;
  }
  if (unit === "dollars") {
    const fmt = (n) =>
      `$${Number(n).toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })}`;
    return `${fmt(used)} / ${fmt(total)}`;
  }
  if (unit === "credits") {
    return `${Number(used).toLocaleString()} / ${Number(total).toLocaleString()} credits`;
  }
  return `${Number(used).toLocaleString()} / ${Number(total).toLocaleString()}`;
}

export default function QuotaProgressBar({
  percentage = 0,
  displayPercentage = null,
  percentageSuffix = null,
  label = "",
  used = 0,
  total = 0,
  unit = null,
  unlimited = false,
  resetTime = null,
}) {
  // percentage = remaining (drives bar fill + color)
  const remaining = percentage;
  const shownPct =
    displayPercentage != null && Number.isFinite(displayPercentage)
      ? displayPercentage
      : remaining;
  const colors = getColorClasses(remaining);
  const countdown = formatResetTime(resetTime);
  const resetDisplay = formatResetTimeDisplay(resetTime);

  return (
    <div className="space-y-2">
      {/* Label and percentage */}
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold text-text-primary">{label}</span>
        <div className="flex items-center gap-1.5">
          <span className="text-xs">{colors.emoji}</span>
          <span className={cn("font-medium", colors.text)}>
            {shownPct}%
            {percentageSuffix ? (
              <span className="text-text-muted font-normal">
                {" "}
                {percentageSuffix}
              </span>
            ) : null}
          </span>
        </div>
      </div>

      {/* Progress bar — width = remaining capacity */}
      {!unlimited && (
        <div className={cn("h-2 rounded-full overflow-hidden", colors.bgLight)}>
          <div
            className={cn("h-full transition-all duration-300", colors.bg)}
            style={{ width: `${Math.min(Math.max(remaining, 0), 100)}%` }}
          />
        </div>
      )}

      {/* Usage details and countdown */}
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>{formatQuotaAmount(used, total, unit)}</span>
        {countdown !== "-" && (
          <div className="flex items-center gap-1">
            <span>•</span>
            <span className="font-medium">Reset in {countdown}</span>
          </div>
        )}
      </div>

      {resetDisplay && (
        <div className="text-xs text-text-muted/70">Reset at {resetDisplay}</div>
      )}
    </div>
  );
}
