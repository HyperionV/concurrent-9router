export function formatBytes(bytes, decimals = 1) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0 B";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];

  const i = Math.floor(Math.log(value) / Math.log(k));
  const safeIndex = Math.min(i, sizes.length - 1);
  return `${parseFloat((value / Math.pow(k, safeIndex)).toFixed(dm))} ${sizes[safeIndex]}`;
}

export function formatDuration(seconds) {
  const sec = Number(seconds);
  if (!Number.isFinite(sec) || sec <= 0) return "0s";

  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);

  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);

  return parts.slice(0, 3).join(" ");
}

export function formatPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0%";
  return `${num.toFixed(1)}%`;
}

export function getStatusColor(percent) {
  if (percent >= 85) {
    return {
      text: "text-rose-500",
      bg: "bg-rose-500",
      border: "border-rose-500/30",
      badge: "error",
    };
  }
  if (percent >= 65) {
    return {
      text: "text-amber-500",
      bg: "bg-amber-500",
      border: "border-amber-500/30",
      badge: "warning",
    };
  }
  return {
    text: "text-emerald-500",
    bg: "bg-emerald-500",
    border: "border-emerald-500/30",
    badge: "success",
  };
}
