import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ChartColumn,
  CircleDollarSign,
  Clock,
  Cpu,
  Gauge,
  Timer,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { CustomPriceModal } from "@/components/CustomPriceModal";
import { ActivityHeatmap } from "@/components/charts/ActivityHeatmap";
import { DimensionBreakdown } from "@/components/charts/DimensionBreakdown";
import { TokenBarChart } from "@/components/charts/TokenBarChart";
import { UsageTimeChart } from "@/components/charts/UsageTimeChart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFormat } from "@/hooks/use-format";
import type { PricingState } from "@/hooks/use-pricing";
import { useI18n } from "@/i18n/context";
import {
  DIMENSION_LABEL_KEY,
  latencyTone,
  speedTone,
  toneTextClass,
  USAGE_DIMENSIONS,
  USAGE_METRICS,
  type UsageDimension,
  type UsageMetric,
} from "@/lib/metrics";
import { groupCostDetails, type ModelPrice, priceFor, totalCost } from "@/lib/pricing";
import { formatDuration, formatPercent } from "@/lib/utils";
import type { SummaryData } from "@/types";

/** 概览拆成多个页签后，每块内容都吃同一份 summary，由 Dashboard 按页签分发。 */
interface OverviewSectionProps {
  summary: SummaryData | null;
  loading: boolean;
  pricing: PricingState;
}

/**
 * 指标条里的一格。6 格共享一个外框，靠 1px 间隙透出分隔线，
 * 比 6 张独立卡片少一层边框、也更像一组数据。
 */
function MetricCell({
  title,
  icon,
  value,
  sub,
  loading = false,
}: {
  title: string;
  icon: ReactNode;
  value: ReactNode;
  sub: ReactNode;
  loading?: boolean;
}) {
  return (
    <div className="bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="[&_svg]:size-3.5">{icon}</span>
        <span className="truncate">{title}</span>
      </div>
      {loading ? (
        <div className="mt-2 space-y-1.5">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-3 w-28" />
        </div>
      ) : (
        <>
          <div className="mt-2 truncate font-mono text-xl font-semibold tabular-nums">{value}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">{sub}</div>
        </>
      )}
    </div>
  );
}

/** 用量总览：KPI + 用量走势 + 维度分布 + Token 构成 + 活动热力图 */
export function OverviewSummary({ summary, loading, pricing }: OverviewSectionProps) {
  const { t } = useI18n();
  const { formatNumber, formatTokens, formatCost } = useFormat();
  const [metric, setMetric] = useState<UsageMetric>("tokens");
  const [dimension, setDimension] = useState<UsageDimension>("model");

  const models = summary?.model_stats ?? [];
  const hourly = summary?.bucket === "hour";
  const costs = totalCost(pricing.table, models);
  const dropped = summary?.dropped_records ?? 0;

  return (
    <div className="space-y-6">
      {/* KPI：6 格共享一个外框，2/3/6 列递进，任何断点都整除 */}
      <div className="overflow-hidden rounded-xl bg-border ring-1 ring-foreground/10">
        <div className="grid grid-cols-2 gap-px md:grid-cols-3 xl:grid-cols-6">
          <MetricCell
            title={t("overview.kpi.requests")}
            icon={<Activity />}
            loading={loading}
            value={formatNumber(summary?.total_requests ?? 0)}
            sub={
              <>
                <span className="font-medium text-foreground">{formatPercent(summary?.success_rate ?? 100)}</span>
                <span>{t("overview.kpi.success_rate")}</span>
                {summary && summary.failed_requests > 0 && (
                  <span className="ml-1 font-medium text-destructive">
                    ({t("overview.kpi.failed_count", { count: formatNumber(summary.failed_requests) })})
                  </span>
                )}
              </>
            }
          />
          <MetricCell
            title={t("overview.kpi.tokens")}
            icon={<Zap />}
            loading={loading}
            value={formatTokens(summary?.total_tokens ?? 0)}
            sub={
              <>
                <span>
                  {t("overview.kpi.io_short", {
                    input: formatTokens(summary?.input_tokens ?? 0),
                    output: formatTokens(summary?.output_tokens ?? 0),
                  })}
                </span>
                <span>·</span>
                <span>{t("overview.kpi.reasoning", { value: formatTokens(summary?.reasoning_tokens ?? 0) })}</span>
              </>
            }
          />
          <MetricCell
            title={t("overview.kpi.cache")}
            icon={<Gauge />}
            loading={loading}
            value={formatPercent(summary?.cache_hit_rate ?? 0)}
            sub={
              <>
                <span>{t("overview.kpi.cache_read", { value: formatTokens(summary?.cache_read_tokens ?? 0) })}</span>
                <span>·</span>
                <span>
                  {t("overview.kpi.cache_write", { value: formatTokens(summary?.cache_creation_tokens ?? 0) })}
                </span>
              </>
            }
          />
          <MetricCell
            title={t("overview.kpi.latency")}
            icon={<Clock />}
            loading={loading}
            value={
              <span className={toneTextClass(latencyTone(summary?.avg_latency_ms ?? 0))}>
                {formatDuration(summary?.avg_latency_ms ?? 0)}
              </span>
            }
            sub={
              <>
                <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
                  <span>TTFT</span>
                  <span className={toneTextClass(latencyTone(summary?.avg_ttft_ms ?? 0))}>
                    {formatDuration(summary?.avg_ttft_ms ?? 0)}
                  </span>
                </span>
                <span>·</span>
                <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
                  <span>P95</span>
                  <span className="font-medium text-foreground">{formatDuration(summary?.p95_latency_ms ?? 0)}</span>
                </span>
              </>
            }
          />
          <MetricCell
            title={t("overview.kpi.throughput")}
            icon={<Timer />}
            loading={loading}
            value={
              <span className={toneTextClass(speedTone(summary?.avg_output_tps ?? 0))}>
                {t("overview.kpi.tps", { value: (summary?.avg_output_tps ?? 0).toFixed(1) })}
              </span>
            }
            sub={
              <span className="truncate">
                {t("overview.kpi.stream_share", {
                  count: formatNumber(summary?.stream_requests ?? 0),
                  total: formatNumber(summary?.total_requests ?? 0),
                })}
              </span>
            }
          />
          <MetricCell
            title={t("overview.kpi.cost")}
            icon={<CircleDollarSign />}
            loading={loading || pricing.loading}
            value={pricing.table ? formatCost(costs.cost) : "-"}
            sub={
              !pricing.table && !pricing.loading ? (
                <span>{t("overview.kpi.pricing_unavailable")}</span>
              ) : costs.total > 0 ? (
                <span className="truncate">
                  {t("overview.kpi.priced", { priced: costs.priced, total: costs.total })}
                </span>
              ) : (
                <span>{t("overview.kpi.no_cost_data")}</span>
              )
            }
          />
        </div>
      </div>
      {!loading && <UnmatchedPricing models={models} pricing={pricing} />}

      {/* 第一排：用量走势 + 维度分布（窄屏自动上下排列） */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="flex flex-col lg:col-span-2">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <TrendingUp className="size-4 text-muted-foreground" />
                {hourly ? t("overview.trend.hourly") : t("overview.trend.daily")}
              </CardTitle>
              <Tabs value={metric} onValueChange={(value) => value && setMetric(value as UsageMetric)}>
                <TabsList className="h-auto flex-wrap">
                  {USAGE_METRICS.map((item) => (
                    <TabsTrigger key={item} value={item} className="h-6.5 px-2 text-xs">
                      {t(`usage_chart.metric_${item}` as never)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            {loading ? (
              <Skeleton className="h-88 w-full" />
            ) : (
              <UsageTimeChart summary={summary} metric={metric} pricing={pricing} />
            )}
          </CardContent>
        </Card>

        <Card className="flex flex-col lg:col-span-1">
          <CardHeader className="gap-2 pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <ChartColumn className="size-4 text-muted-foreground" />
              {t("overview.dimension.title")}
            </CardTitle>
            <Tabs value={dimension} onValueChange={(value) => value && setDimension(value as UsageDimension)}>
              <TabsList className="h-auto flex-wrap">
                {USAGE_DIMENSIONS.map((item) => (
                  <TabsTrigger key={item} value={item} className="h-6.5 px-2 text-xs">
                    {t(DIMENSION_LABEL_KEY[item] as never)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="pt-2">
            {loading ? (
              <Skeleton className="h-88 w-full" />
            ) : (
              <DimensionBreakdown
                stats={{
                  model: summary?.model_stats ?? [],
                  provider: summary?.provider_stats ?? [],
                  session: summary?.session_stats ?? [],
                  auth: summary?.auth_stats ?? [],
                  key: summary?.api_key_stats ?? [],
                }}
                dimension={dimension}
                metric={metric}
                pricing={pricing}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* 第二排：Token 构成 + 活动热力图，热力图占两列保持可读宽度 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="flex flex-col lg:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Cpu className="size-4 text-muted-foreground" />
              {t("overview.tokens_dist.title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 items-center pt-2">
            {loading ? <Skeleton className="h-52 w-full" /> : <TokenBarChart summary={summary} />}
          </CardContent>
        </Card>

        {/* GitHub 风格活动热力图：按天查看请求 / Token / 费用 */}
        <Card className="flex flex-col lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <CalendarDays className="size-4 text-muted-foreground" />
              {t("heatmap.title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-2">
            {loading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <ActivityHeatmap summary={summary} pricingTable={pricing.table} />
            )}
          </CardContent>
        </Card>
      </div>

      {dropped > 0 && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t("overview.dropped.title", { count: formatNumber(dropped) })}</AlertTitle>
          <AlertDescription>{t("overview.dropped.desc")}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** 未匹配定价的模型：模型表移除后保留唯一的改价入口，成本指标才能被修正。 */
function UnmatchedPricing({ models, pricing }: { models: SummaryData["model_stats"]; pricing: PricingState }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{ modelName: string; price: ModelPrice | null; isCustom: boolean } | null>(
    null,
  );
  if (!pricing.table) return null;

  const unmatched = models.filter((model) => !groupCostDetails(pricing.table, model));
  if (unmatched.length === 0) return null;

  return (
    <>
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2 border-b pb-2">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <CircleDollarSign className="size-4 text-muted-foreground" />
            {t("overview.models.unmatched_title")}
          </h2>
          <span className="text-xs text-muted-foreground">
            {t("overview.models.unmatched_desc", { count: unmatched.length })}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {unmatched.slice(0, 24).map((model) => (
            <Button
              key={`${model.name}-${model.secondary ?? ""}`}
              variant="outline"
              size="xs"
              className="max-w-64 gap-1.5 font-mono"
              title={model.name}
              onClick={() =>
                setEditing({
                  modelName: model.name,
                  price: pricing.table
                    ? (priceFor(pricing.table, { model: model.name, provider: model.secondary ?? "" })?.price ?? null)
                    : null,
                  isCustom: false,
                })
              }
            >
              <span className="truncate">{model.name}</span>
            </Button>
          ))}
        </div>
      </section>
      {editing && (
        <CustomPriceModal
          open
          modelName={editing.modelName}
          currentPrice={editing.price}
          isCustom={editing.isCustom}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            pricing.reload();
          }}
        />
      )}
    </>
  );
}
