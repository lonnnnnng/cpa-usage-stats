import {
  Activity,
  AlertTriangle,
  CalendarDays,
  ChartColumn,
  CircleDollarSign,
  Clock,
  Cpu,
  Database,
  Gauge,
  Timer,
  TrendingUp,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { CustomPriceModal } from "@/components/CustomPriceModal";
import { ActivityHeatmap } from "@/components/charts/ActivityHeatmap";
import { DimensionUsageChart } from "@/components/charts/DimensionUsageChart";
import { DonutChart } from "@/components/charts/DonutChart";
import { TokenBarChart } from "@/components/charts/TokenBarChart";
import { TrendChart } from "@/components/charts/TrendChart";
import { latencyTone, speedTone, toneTextClass } from "@/components/charts/UsageBarChart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFormat } from "@/hooks/use-format";
import type { PricingState } from "@/hooks/use-pricing";
import { useI18n } from "@/i18n/context";
import { groupCostDetails, type ModelPrice, priceFor, totalCost } from "@/lib/pricing";
import { formatDuration, formatPercent } from "@/lib/utils";
import type { SummaryData } from "@/types";

type TrendView = "requests" | "tokens";

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

/** 用量总览：KPI 指标条 + 趋势/Provider 分布 */
export function OverviewSummary({ summary, loading, pricing }: OverviewSectionProps) {
  const { t } = useI18n();
  const { formatNumber, formatTokens, formatCost } = useFormat();
  const [trendView, setTrendView] = useState<TrendView>("requests");

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
      {/* 宏观三图联动：调用走势 + Token 构成 + 渠道分布，卡片等高、图表区定高，避免内容少时上方留白 */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* 图 1：调用走势 */}
        <Card className="flex flex-col">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <TrendingUp className="size-4 text-muted-foreground" />
                {hourly ? t("overview.trend.hourly") : t("overview.trend.daily")}
              </CardTitle>
              <Tabs value={trendView} onValueChange={(value) => value && setTrendView(value as TrendView)}>
                <TabsList className="h-7">
                  <TabsTrigger value="requests" className="px-2 text-xs">
                    {t("overview.trend.tab_requests")}
                  </TabsTrigger>
                  <TabsTrigger value="tokens" className="px-2 text-xs">
                    {t("overview.trend.tab_tokens")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 items-center pt-2">
            {loading ? (
              <Skeleton className="h-52 w-full" />
            ) : (
              <TrendChart points={summary?.trend ?? []} hourly={hourly} view={trendView} />
            )}
          </CardContent>
        </Card>

        {/* 图 2：Token 构成与分布（水平条形图，使用 chart 色阶） */}
        <Card className="flex flex-col">
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

        {/* 图 3：Provider 渠道分布（环形图，使用 chart 色阶） */}
        <Card className="flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="size-4 text-muted-foreground" />
              {t("overview.provider_title" as never)}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-1 items-center pt-2">
            {loading ? (
              <Skeleton className="h-52 w-full" />
            ) : (
              <DonutChart stats={summary?.provider_stats ?? []} metric="total_tokens" />
            )}
          </CardContent>
        </Card>
      </div>

      {/* GitHub 风格活动热力图：按天查看请求 / Token / 费用 */}
      <Card>
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

/** 用量分布：维度 × 指标两个 tab 组共享一份聚合数据，会话维度并入同一张直方图。 */
export function OverviewUsage({ summary, loading, pricing }: OverviewSectionProps) {
  const { t } = useI18n();
  const models = summary?.model_stats ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ChartColumn className="size-4 text-muted-foreground" />
            {t("usage_tab.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <DimensionUsageChart
              stats={{
                model: summary?.model_stats ?? [],
                provider: summary?.provider_stats ?? [],
                session: summary?.session_stats ?? [],
                auth: summary?.auth_stats ?? [],
                key: summary?.api_key_stats ?? [],
              }}
              pricingTable={pricing.table}
              dimensions={["model", "provider", "session", "auth", "key"]}
              defaultDimension="model"
            />
          )}
        </CardContent>
      </Card>

      {!loading && <UnmatchedPricing models={models} pricing={pricing} />}
    </div>
  );
}
