import { useFormat } from "@/hooks/use-format";
import type { PricingState } from "@/hooks/use-pricing";
import { useI18n } from "@/i18n/context";
import { groupMetricValue, type UsageDimension, type UsageMetric } from "@/lib/metrics";
import { costPerToken, groupCostDetails } from "@/lib/pricing";
import { cn, displayAuthName, formatDuration, maskApiKey } from "@/lib/utils";
import type { GroupStat } from "@/types";

const VISIBLE_ROWS = 12;
const SESSION_ROWS = 5;

function barColor(index: number): string {
  const token = `var(--chart-${(index % 5) + 1})`;
  return index < 5 ? token : `color-mix(in oklab, ${token} 60%, transparent)`;
}

function shortLabel(dimension: UsageDimension, stat: GroupStat): string {
  const raw = stat.name || "-";
  let text = raw;
  if (dimension === "key") text = maskApiKey(raw);
  else if (dimension === "auth") text = displayAuthName(raw);
  if (dimension === "auth" && stat.secondary) text = `${text} #${stat.secondary}`;
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

function fullLabel(dimension: UsageDimension, stat: GroupStat): string {
  const raw = stat.name || "-";
  return dimension === "auth" && stat.secondary ? `${raw} #${stat.secondary}` : raw;
}

interface DimensionBreakdownProps {
  stats: Partial<Record<UsageDimension, GroupStat[]>>;
  dimension: UsageDimension;
  metric: UsageMetric;
  pricing: PricingState;
  className?: string;
}

/**
 * 维度分布：横向条形列表，展示当前维度的用量排行与请求/词元/费用明细。
 * 模型维度的费用按各自单价计算；其它维度没有逐模型数据，用整体混合单价估算。
 */
export function DimensionBreakdown({ stats, dimension, metric, pricing, className }: DimensionBreakdownProps) {
  const { t } = useI18n();
  const { formatNumber, formatTokens, formatCost } = useFormat();

  const costRate = costPerToken(pricing.table, stats.model ?? []);
  const limit = dimension === "session" ? SESSION_ROWS : VISIBLE_ROWS;

  const rows = (stats[dimension] ?? [])
    .map((stat) => {
      // 模型维度逐模型计价；其它维度没有逐模型数据，只能按整体混合单价估算。
      const cost =
        dimension === "model"
          ? (groupCostDetails(pricing.table, stat)?.cost ?? 0)
          : costRate === null
            ? 0
            : stat.total_tokens * costRate;
      return { stat, cost, value: groupMetricValue(stat, metric, cost) };
    })
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((row, index) => ({ ...row, fill: barColor(index) }));

  const formatValue = (value: number) => {
    if (metric === "tokens") return formatTokens(value);
    if (metric === "requests") return formatNumber(value);
    if (metric === "cost") return formatCost(value);
    if (metric === "latency") return formatDuration(value);
    return t("usage_chart.tps", { value: value.toFixed(1) });
  };

  if (rows.length === 0) {
    return (
      <div className={cn("flex h-88 items-center justify-center text-xs text-muted-foreground", className)}>
        {metric === "cost" && !pricing.table ? t("usage_chart.cost_unavailable") : t("usage_chart.empty")}
      </div>
    );
  }

  const max = rows[0].value;

  return (
    <div className={cn("h-88 space-y-3 overflow-y-auto pr-1", className)}>
      {rows.map(({ stat, cost, value, fill }) => (
        <div key={`${stat.name}-${stat.secondary ?? ""}`} className="space-y-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-mono text-xs text-foreground" title={fullLabel(dimension, stat)}>
              {shortLabel(dimension, stat)}
            </span>
            <span className="shrink-0 font-mono text-xs font-medium tabular-nums">{formatValue(value)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full transition-[width]"
              style={{ width: `${Math.max(2, (value / max) * 100)}%`, background: fill }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>
              {t("usage_chart.metric_requests")} {formatNumber(stat.requests)}
            </span>
            <span>
              {t("usage_chart.metric_tokens")} {formatTokens(stat.total_tokens)}
            </span>
            <span>
              {t("usage_chart.metric_cost")} {formatCost(cost)}
            </span>
            {stat.failed > 0 && (
              <span className="text-destructive">{t("overview.kpi.failed_count", { count: stat.failed })}</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
