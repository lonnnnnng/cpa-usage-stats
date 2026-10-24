import { cn } from "cn";

export { cn };

// 与展示偏好相关的 formatNumber / formatTokens / formatCost / formatUnitPrice 在 @/lib/format，
// 由 useFormat() 按用户的数字单位与币种设置构造，见 hooks/use-format.tsx。

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0ms";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct)) return "-";
  return `${pct.toFixed(1)}%`;
}

/** 字节数按 1024 进制展示，用于数据库文件占用 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 || value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

const DISPLAY_TIME_ZONE = "Asia/Shanghai";
const DISPLAY_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: DISPLAY_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

type DisplayParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function displayParts(date: Date): DisplayParts {
  const parts = Object.fromEntries(
    DISPLAY_TIME_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]),
  ) as Partial<DisplayParts>;
  return {
    year: parts.year ?? "",
    month: parts.month ?? "",
    day: parts.day ?? "",
    hour: parts.hour ?? "",
    minute: parts.minute ?? "",
    second: parts.second ?? "",
  };
}

/**
 * 后端把无时区的 SQLite 时间作为墙上时间返回；这里按 UTC 解释，统一换算成北京时间。
 * 已带 Z 或 offset 的 RFC3339 时间则直接按其绝对时刻处理，避免重复加 8 小时。
 */
export function parseBackendTimestamp(value: string, granularity?: "hour" | "day"): Date | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return null;

  let normalized = trimmed.replace(" ", "T");
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  if (!hasTimeZone) {
    if (granularity === "hour" && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(normalized)) {
      normalized += ":00:00";
    } else if (granularity === "day" && /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      normalized += "T00:00:00";
    }
    normalized += "Z";
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** "2026-09-28T15:04:05Z" → "09-28 23:04:05"（北京时间） */
export function formatDateTime(stored: string): string {
  const date = parseBackendTimestamp(stored);
  if (!date) return "-";
  const parts = displayParts(date);
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** 完整日期时间，用于存储统计中的最早/最新记录。 */
export function formatDateTimeFull(stored: string | undefined): string {
  const date = parseBackendTimestamp(stored ?? "");
  if (!date) return "-";
  const parts = displayParts(date);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** 将时间转换为北京时间的日历日期，供热力图按天聚合。 */
export function formatDisplayDateKey(date: Date): string {
  const parts = displayParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 小时桶 "2026-09-28 15" → "23:00"；天桶 → "09-28"（北京时间） */
export function formatBucket(bucket: string, hourly: boolean): string {
  const date = parseBackendTimestamp(bucket, hourly ? "hour" : "day");
  if (!date) return "-";
  const parts = displayParts(date);
  return hourly ? `${parts.hour}:00` : `${parts.month}-${parts.day}`;
}

/** 脱敏 API Key：保留可辨识前缀与末 4 位 */
export function maskApiKey(key: string): string {
  const trimmed = (key ?? "").trim();
  if (!trimmed || trimmed === "-") return "-";
  if (trimmed.length <= 4) return "••••";
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}••••${trimmed.slice(-2)}`;
  if (trimmed.startsWith("sk-proj-") && trimmed.length > 16) return `sk-proj-••••${trimmed.slice(-4)}`;
  if (trimmed.startsWith("sk-ant-") && trimmed.length > 15) return `sk-ant-••••${trimmed.slice(-4)}`;
  if (trimmed.length > 14) return `${trimmed.slice(0, 6)}••••${trimmed.slice(-4)}`;
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-3)}`;
}

/** 上游凭据展示名：去掉 CPA 凭据文件名的 .json 后缀，账号部分才是辨识信息 */
export function displayAuthName(name: string): string {
  return name.replace(/\.json$/i, "");
}

/**
 * 复制到系统剪贴板。看板运行在管理中心的 iframe 里，某些环境下
 * Clipboard API 不可用，这里退回 textarea + execCommand。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 权限被拒或非安全上下文，继续走兜底方案
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
