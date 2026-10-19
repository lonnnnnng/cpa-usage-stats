import type { GroupStat } from "@/types";

/** 用量图表可切换的指标，主图与维度分布共用同一选择。 */
export type UsageMetric = "tokens" | "cost" | "requests" | "speed" | "latency";

export const USAGE_METRICS: UsageMetric[] = ["tokens", "cost", "requests", "speed", "latency"];

/** 可参与维度分布的聚合维度。 */
export type UsageDimension = "model" | "provider" | "session" | "auth" | "key";

export const USAGE_DIMENSIONS: UsageDimension[] = ["model", "provider", "session", "auth", "key"];

export const DIMENSION_LABEL_KEY: Record<UsageDimension, string> = {
  model: "usage_chart.dim_model",
  provider: "usage_chart.dim_provider",
  session: "usage_chart.dim_session",
  auth: "usage_chart.dim_auth",
  key: "usage_chart.dim_key",
};

/** 速度分档：越快越绿，慢到影响体验才转黄/红 */
export function speedTone(speed: number | null): "success" | "warning" | "danger" | "muted" {
  if (speed === null || speed <= 0) return "muted";
  if (speed >= 40) return "success";
  if (speed >= 15) return "warning";
  return "danger";
}

/** 延迟分档：越快越绿 */
export function latencyTone(ms: number): ReturnType<typeof speedTone> {
  if (ms <= 0) return "muted";
  if (ms <= 2000) return "success";
  if (ms <= 8000) return "warning";
  return "danger";
}

export function toneTextClass(tone: ReturnType<typeof speedTone>): string {
  switch (tone) {
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "danger":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

/** 按请求平均输出 token / 平均耗时折算输出速度（tokens/s）。 */
export function groupSpeed(stat: GroupStat): number | null {
  return stat.requests > 0 && stat.output_tokens > 0 && stat.avg_latency_ms > 0
    ? (stat.output_tokens / stat.requests / stat.avg_latency_ms) * 1000
    : null;
}

export function groupMetricValue(stat: GroupStat, metric: UsageMetric, cost: number): number {
  switch (metric) {
    case "tokens":
      return stat.total_tokens;
    case "requests":
      return stat.requests;
    case "cost":
      return cost;
    case "latency":
      return stat.avg_latency_ms > 0 ? stat.avg_latency_ms : 0;
    default:
      return groupSpeed(stat) ?? 0;
  }
}
