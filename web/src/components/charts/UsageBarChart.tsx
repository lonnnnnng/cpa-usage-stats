import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useFormat } from "@/hooks/use-format";
import { useI18n } from "@/i18n/context";
import { cn, formatDuration } from "@/lib/utils";

export type UsageMetric = "tokens" | "cost" | "requests" | "speed" | "latency";

export type UsageRow = {
  key: string;
  /** 主轴展示名（已截断） */
  label: string;
  /** 悬浮与次行展示的完整名称 */
  fullName: string;
  /** 次行补充信息，如 provider */
  hint?: string;
  tokens: number;
  requests: number;
  cost: number;
  /** 输出速度 tokens/s；无数据为 null */
  speed: number | null;
  /** 平均耗时，毫秒 */
  latency: number | null;
  failed: number;
};

const METRIC_ORDER: UsageMetric[] = ["tokens", "cost", "requests", "speed", "latency"];
const VISIBLE_BARS = 12;

/** 5 级 chart 色阶，超出后降低透明度复用 */
function barColor(index: number): string {
  const token = `var(--chart-${(index % 5) + 1})`;
  return index < 5 ? token : `color-mix(in oklab, ${token} 60%, transparent)`;
}

/** 速度分档：越快越绿，慢到影响体验才转黄/红 */
export function speedTone(speed: number | null): "success" | "warning" | "danger" | "muted" {
  if (speed === null || speed <= 0) return "muted";
  if (speed >= 40) return "success";
  if (speed >= 15) return "warning";
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

const formatDurationMs = (ms: number) => formatDuration(ms);

/** 延迟分档：越快越绿 */
export function latencyTone(ms: number): ReturnType<typeof speedTone> {
  if (ms <= 0) return "muted";
  if (ms <= 2000) return "success";
  if (ms <= 8000) return "warning";
  return "danger";
}

export function metricValue(row: UsageRow, metric: UsageMetric): number {
  if (metric === "tokens") return row.tokens;
  if (metric === "requests") return row.requests;
  if (metric === "cost") return row.cost;
  if (metric === "latency") return row.latency ?? 0;
  return row.speed ?? 0;
}

function metricLabelKey(metric: UsageMetric): string {
  switch (metric) {
    case "tokens":
      return "usage_chart.metric_tokens";
    case "requests":
      return "usage_chart.metric_requests";
    case "cost":
      return "usage_chart.metric_cost";
    case "latency":
      return "usage_chart.metric_latency";
    default:
      return "usage_chart.metric_speed";
  }
}

interface UsageBarChartProps {
  rows: UsageRow[];
  metric: UsageMetric;
  /** 成本受定价表影响，未就绪时该指标不可用 */
  pricingReady?: boolean;
  className?: string;
}

/**
 * 纵向直方图：同一份聚合数据按指标切换展示，排序后取前 N 项。
 * 横向排布是为了让模型名、账号这类长文本有稳定的横轴标签位置。
 */
export function UsageBarChart({ rows, metric, pricingReady = true, className }: UsageBarChartProps) {
  const { t } = useI18n();
  const { formatNumber, formatTokens, formatCost } = useFormat();

  const ranked = rows
    .filter((row) => metricValue(row, metric) > 0)
    .sort((a, b) => metricValue(b, metric) - metricValue(a, metric))
    .slice(0, VISIBLE_BARS)
    .map((row, index) => ({ ...row, fill: barColor(index) }));

  if (ranked.length === 0) {
    return (
      <div className={cn("flex h-64 items-center justify-center text-xs text-muted-foreground", className)}>
        {metric === "cost" && !pricingReady ? t("usage_chart.cost_unavailable") : t("usage_chart.empty")}
      </div>
    );
  }

  const formatTick = (value: number) => {
    if (metric === "tokens") return formatTokens(value);
    if (metric === "requests") return formatNumber(value);
    if (metric === "cost") return formatCost(value);
    if (metric === "latency") return formatDurationMs(value);
    return t("usage_chart.tps_short", { value: Math.round(value) });
  };

  const formatMetric = (value: number) => {
    if (metric === "tokens") return `${formatTokens(value)} ${t("usage_chart.metric_tokens")}`;
    if (metric === "requests") return `${formatNumber(value)} ${t("usage_chart.metric_requests")}`;
    if (metric === "cost") return formatCost(value);
    if (metric === "latency") return formatDurationMs(value);
    return t("usage_chart.tps", { value: value.toFixed(1) });
  };

  return (
    <div className={cn("h-72 w-full", className)}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart layout="vertical" data={ranked} margin={{ top: 0, right: 24, left: 0, bottom: 0 }}>
          <CartesianGrid horizontal={false} strokeDasharray="3 3" className="stroke-muted/40" />
          <XAxis
            type="number"
            tickFormatter={formatTick}
            className="fill-muted-foreground font-mono text-[10px]"
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            type="category"
            dataKey="label"
            width={148}
            tickLine={false}
            axisLine={false}
            className="fill-muted-foreground font-mono text-[11px]"
          />
          <Tooltip
            cursor={{ fill: "var(--muted)", opacity: 0.3 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const row = payload[0].payload as UsageRow & { fill: string };
              return (
                <div className="max-w-xs space-y-1 rounded-lg border bg-popover p-2 text-xs text-popover-foreground shadow-md">
                  <div className="flex items-center gap-1.5 font-mono font-semibold text-foreground">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: row.fill }} />
                    <span className="break-all">{row.fullName}</span>
                  </div>
                  {row.hint && <div className="text-[11px] text-muted-foreground">{row.hint}</div>}
                  <div className="space-y-0.5 border-t pt-1 font-mono text-[11px] tabular-nums">
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{t("usage_chart.metric_label")}:</span>
                      <span className="font-semibold">{formatMetric(metricValue(row, metric))}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{t("usage_chart.metric_tokens")}:</span>
                      <span>{formatTokens(row.tokens)}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{t("usage_chart.metric_requests")}:</span>
                      <span>
                        {formatNumber(row.requests)}
                        {row.failed > 0 && <span className="ml-1 text-destructive">({formatNumber(row.failed)})</span>}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{t("usage_chart.metric_cost")}:</span>
                      <span>{formatCost(row.cost)}</span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{t("usage_chart.metric_speed")}:</span>
                      <span className={toneTextClass(speedTone(row.speed))}>
                        {row.speed === null ? "-" : t("usage_chart.tps", { value: row.speed.toFixed(1) })}
                      </span>
                    </div>
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">{t("usage_chart.metric_latency")}:</span>
                      <span className={row.latency === null ? undefined : toneTextClass(latencyTone(row.latency))}>
                        {row.latency === null ? "-" : formatDuration(row.latency)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            }}
          />
          <Bar dataKey={(row: UsageRow) => metricValue(row, metric)} radius={[0, 4, 4, 0]} maxBarSize={18}>
            {ranked.map((row) => (
              <Cell key={row.key} fill={row.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export { METRIC_ORDER, metricLabelKey, VISIBLE_BARS };
