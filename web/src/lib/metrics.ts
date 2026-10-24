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

/** 调用明细的耗时分档：10 秒内可接受，60 秒内需留意，其余标红。作者：long */
export function recordLatencyTone(ms: number | null): ReturnType<typeof speedTone> {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "muted";
  if (ms < 10_000) return "success";
  if (ms < 60_000) return "warning";
  return "danger";
}

export type CacheSemantics = "subset" | "independent";

/**
 * CPA 的 OpenAI/Codex input_tokens 已包含缓存子集，Anthropic 则把未缓存、
 * 缓存读取和缓存写入分成三个桶；前端必须沿用同一口径，避免混算。作者：long
 */
export function classifyCacheSemantics(provider = "", executorType = "", source = ""): CacheSemantics {
  const value = `${provider} ${executorType} ${source}`.toLowerCase();
  return value.includes("anthropic") || value.includes("claude") ? "independent" : "subset";
}

export function cacheHitRatePercent(
  input: number,
  cacheRead: number,
  cacheCreation: number,
  provider = "",
  executorType = "",
  source = "",
): number | null {
  if (cacheRead < 0 || cacheCreation < 0) return null;
  const semantics = classifyCacheSemantics(provider, executorType, source);
  const prompt = semantics === "independent" ? input + cacheRead + cacheCreation : input || cacheRead + cacheCreation;
  return prompt > 0 ? (cacheRead / prompt) * 100 : null;
}

export type RequestProtocol = "anthropic_messages" | "openai_responses" | "openai_chat" | "openai_unknown" | "unknown";

/**
 * 仅根据 CPA 已提供的元数据标注协议族；请求 path 不在 usage hook 中，
 * 所以不能把它伪装成已确认的 /v1/chat/completions、/v1/responses 或 /v1/messages。作者：long
 */
export function classifyRequestProtocol(provider = "", executorType = "", source = ""): RequestProtocol {
  const value = `${provider} ${executorType} ${source}`.toLowerCase();
  if (value.includes("anthropic") || value.includes("claude")) return "anthropic_messages";
  if (value.includes("responses")) return "openai_responses";
  if (value.includes("chat/completions") || value.includes("chatcompletion")) {
    return "openai_chat";
  }
  if (value.includes("openai") || value.includes("codex")) return "openai_unknown";
  return "unknown";
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
