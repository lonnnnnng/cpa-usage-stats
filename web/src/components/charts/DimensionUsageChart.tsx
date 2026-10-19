import { useState } from "react";
import { UsageBarChart, type UsageMetric, type UsageRow } from "@/components/charts/UsageBarChart";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/i18n/context";
import { groupCostDetails, type PricingTable } from "@/lib/pricing";
import { displayAuthName, maskApiKey } from "@/lib/utils";
import type { GroupStat } from "@/types";

/** 维度键 → i18n 后缀，hooks 层不需要再关心具体文案。 */
export type UsageDimension = "model" | "provider" | "session" | "auth" | "key";

export type DimensionStats = Partial<Record<UsageDimension, GroupStat[]>>;

const DIMENSION_LABEL_KEY: Record<UsageDimension, string> = {
  model: "usage_chart.dim_model",
  provider: "usage_chart.dim_provider",
  session: "usage_chart.dim_session",
  auth: "usage_chart.dim_auth",
  key: "usage_chart.dim_key",
};

/** 长标识截断成可辨认的前缀，完整值放在 fullName 里由悬浮展示。 */
function shortLabel(dimension: UsageDimension, stat: GroupStat): string {
  const raw = stat.name || "-";
  let text = raw;
  if (dimension === "key") text = maskApiKey(raw);
  else if (dimension === "auth") text = displayAuthName(raw);
  if (dimension === "auth" && stat.secondary) text = `${text} #${stat.secondary}`;
  // 纵向直方图的分类标签空间更窄，截得更短，完整值由 tooltip 展示
  return text.length > 12 ? `${text.slice(0, 11)}…` : text;
}

function fullLabel(dimension: UsageDimension, stat: GroupStat): string {
  const raw = stat.name || "-";
  if (dimension === "auth" && stat.secondary) return `${raw} #${stat.secondary}`;
  return raw;
}

/** 会话数量可能非常多，只看当前指标下排名前几的会话。 */
const DIMENSION_LIMITS: Partial<Record<UsageDimension, number>> = {
  session: 5,
};

/** GroupStat 转直方图行；速度与延迟为 0 时显示为无数据而不是 0。 */
export function toUsageRows(
  dimension: UsageDimension,
  stats: GroupStat[],
  pricingTable: PricingTable | null,
): UsageRow[] {
  return stats.map((stat, index) => {
    const cost = groupCostDetails(pricingTable, stat)?.cost ?? 0;
    // 速度按“平均每次请求的输出 token / 平均耗时”折算，各维度口径一致。
    const speed =
      stat.requests > 0 && stat.output_tokens > 0 && stat.avg_latency_ms > 0
        ? (stat.output_tokens / stat.requests / stat.avg_latency_ms) * 1000
        : null;
    return {
      key: `${dimension}-${stat.name}-${stat.secondary ?? ""}-${index}`,
      label: shortLabel(dimension, stat),
      fullName: fullLabel(dimension, stat),
      hint: dimension === "model" ? stat.secondary : undefined,
      tokens: stat.total_tokens,
      requests: stat.requests,
      cost,
      speed,
      latency: stat.avg_latency_ms > 0 ? stat.avg_latency_ms : null,
      failed: stat.failed,
    };
  });
}

interface DimensionUsageChartProps {
  stats: DimensionStats;
  pricingTable: PricingTable | null;
  /** 维度 tab 的顺序，调用方决定展示哪些维度 */
  dimensions: UsageDimension[];
  defaultDimension?: UsageDimension;
}

/**
 * 用量直方图：维度 tab 决定“看谁”，指标 tab 决定“看什么”。
 * 两个 tab 组共享同一份 GroupStat 聚合，切维度不重新取数。
 */
export function DimensionUsageChart({ stats, pricingTable, dimensions, defaultDimension }: DimensionUsageChartProps) {
  const { t } = useI18n();
  const [dimension, setDimension] = useState<UsageDimension>(defaultDimension ?? dimensions[0]);
  const [metric, setMetric] = useState<UsageMetric>("tokens");

  const active = stats[dimension] ?? [];
  const rows = toUsageRows(dimension, active, pricingTable);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <Tabs value={dimension} onValueChange={(value) => value && setDimension(value as UsageDimension)}>
          <TabsList className="h-auto flex-wrap">
            {dimensions.map((item) => (
              <TabsTrigger key={item} value={item} className="h-6.5 px-2.5 text-xs">
                {t(DIMENSION_LABEL_KEY[item] as never)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Tabs value={metric} onValueChange={(value) => value && setMetric(value as UsageMetric)}>
          <TabsList className="h-auto flex-wrap">
            {(["tokens", "cost", "requests", "speed", "latency"] as UsageMetric[]).map((item) => (
              <TabsTrigger key={item} value={item} className="h-6.5 px-2.5 text-xs">
                {t(`usage_chart.metric_${item}` as never)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <UsageBarChart
        rows={rows}
        metric={metric}
        limit={DIMENSION_LIMITS[dimension]}
        pricingReady={Boolean(pricingTable)}
        className="flex-1"
      />
    </div>
  );
}

export { DIMENSION_LABEL_KEY };
