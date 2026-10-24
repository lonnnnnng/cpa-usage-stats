import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChartColumn, KeyRound, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { DisplaySettings } from "@/components/DisplaySettings";
import { KeyDialog } from "@/components/KeyDialog";
import { LanguageToggle } from "@/components/language-toggle";
import { Logo } from "@/components/logo";
import { OverviewSummary } from "@/components/OverviewTab";
import { PricingSource } from "@/components/PricingSource";
import { RecordsTab } from "@/components/RecordsTab";
import { StorageTab } from "@/components/StorageTab";
import { ThemeToggle } from "@/components/theme-toggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFormat } from "@/hooks/use-format";
import { useManagementKey } from "@/hooks/use-management-key";
import { usePricing } from "@/hooks/use-pricing";
import { useI18n } from "@/i18n/context";
import { fetchOptions, fetchRecords, fetchSummary, keyFingerprint, UnauthorizedError } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { OptionsResponse, RecordListResponse, RecordsFilters, SummaryData, TimeRange } from "@/types";

/** 概览拆成多页签后的页签值；@/types 里的 TabKey 只有 overview/records 两态，已不适用 */
type TabKey = "overview" | "records" | "storage";

const PAGE_SIZE_OPTIONS = [15, 30, 50, 100];

const RANGE_OPTIONS: TimeRange[] = ["today", "yesterday", "7d", "30d", "all"];

const REFRESH_OPTIONS = [
  { value: "0", labelKey: "dashboard.auto_refresh.off" },
  { value: "10", labelKey: "dashboard.auto_refresh.10" },
  { value: "30", labelKey: "dashboard.auto_refresh.30" },
  { value: "60", labelKey: "dashboard.auto_refresh.60" },
] as const;

const EMPTY_FILTERS: RecordsFilters = {
  model: "",
  provider: "",
  apiKey: "",
  authId: "",
  sessionId: "",
  status: "all",
  keyword: "",
};

interface LoadResult {
  summary: SummaryData;
  records: RecordListResponse;
  options: OptionsResponse;
}

export function Dashboard() {
  const { t } = useI18n();
  const { formatNumber } = useFormat();
  const { key, source, setKey, clear } = useManagementKey();
  const pricing = usePricing();

  const [tab, setTab] = useState<TabKey>("overview");
  const [range, setRange] = useState<TimeRange>("today");
  const [filters, setFilters] = useState<RecordsFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);
  const [autoRefresh, setAutoRefresh] = useState("0");
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  // 输入密钥后先保持弹窗，等这一轮请求成功再自动关闭，失败则原地显示错误
  const [savingKey, setSavingKey] = useState(false);

  const query = useQuery<LoadResult>({
    queryKey: ["usage", keyFingerprint(key), range, filters, page, pageSize],
    enabled: Boolean(key),
    retry: (count, error) => !(error instanceof UnauthorizedError) && count < 2,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      // 先用 options 探测密钥：密钥错误时只消耗 1 次认证失败计数（CPA 连续 5 次失败封禁 IP 30 分钟）
      const options = await fetchOptions(key);
      const failed = filters.status === "all" ? undefined : filters.status === "failed" ? "true" : "false";
      const shared = { ...filters, range, failed };
      const [summary, records] = await Promise.all([
        fetchSummary(key, shared),
        fetchRecords(key, shared, page, pageSize),
      ]);
      return { summary, records, options };
    },
  });

  const { refetch, isPending, isFetching } = query;
  // 作者：long。后台刷新必须保留已有结果，只有首次没有数据时才显示骨架屏，避免列表闪空。
  const loading = isPending && !query.data;
  const refreshing = isFetching && Boolean(query.data);

  useEffect(() => {
    const seconds = Number(autoRefresh);
    if (!key || !seconds) return;
    const id = setInterval(() => void refetch(), seconds * 1000);
    return () => clearInterval(id);
  }, [autoRefresh, key, refetch]);

  const unauthorized = query.error instanceof UnauthorizedError;
  const summary = query.data?.summary ?? null;
  const records = query.data?.records ?? null;
  const options = query.data?.options ?? { models: [], providers: [], api_keys: [], auths: [] };
  const empty = summary !== null && summary.total_requests === 0;

  // 新密钥验证通过后自动收起弹窗
  useEffect(() => {
    if (!savingKey || loading) return;
    if (!unauthorized) {
      setKeyDialogOpen(false);
      setSavingKey(false);
    }
  }, [savingKey, loading, unauthorized]);

  return (
    <div className="w-full max-w-none space-y-4 p-4 md:p-6">
      <header className="flex items-center gap-3 border-b pb-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Logo className="size-8 shrink-0 rounded-md" />
          <h1 className="truncate text-lg font-semibold tracking-tight md:text-xl">{t("dashboard.title")}</h1>
        </div>
      </header>

      {unauthorized && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t("dashboard.key.invalid")}</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="xs" onClick={() => setKeyDialogOpen(true)}>
              {t("dashboard.key.action")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {query.error && !unauthorized && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>{t("dashboard.load_failed", { message: (query.error as Error).message })}</AlertTitle>
        </Alert>
      )}

      {!key && (
        <Alert>
          <KeyRound />
          <AlertTitle>{t("auth.title")}</AlertTitle>
          <AlertDescription>
            <p>{t("auth.desc")}</p>
            <Button size="xs" className="mt-2" onClick={() => setKeyDialogOpen(true)}>
              {t("dashboard.key.submit")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)} className="gap-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {/*
            窄屏下 3 个页签放不进一行：让列表换行（h-auto 覆盖基础样式的固定 h-8），
            并给触发器一个确定高度，替代依赖父级高度的 h-[calc(100%-1px)]。
          */}
          <TabsList className="flex-wrap group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="overview" className="h-6.5">
              {t("dashboard.tabs.overview")}
            </TabsTrigger>
            <TabsTrigger value="records" className="h-6.5">
              {t("dashboard.tabs.records")}
            </TabsTrigger>
            <TabsTrigger value="storage" className="h-6.5">
              {t("dashboard.tabs.storage")}
            </TabsTrigger>
          </TabsList>
          <div className="flex flex-wrap items-center gap-2 sm:flex-1 sm:justify-center">
            {/* 作者：long。把全局查询与外观控制放在主页签行，避免占用标题栏并保持内容上下文一致。 */}
            <Tabs
              value={range}
              onValueChange={(value) => {
                if (!value) return;
                setRange(value as TimeRange);
                setPage(1);
              }}
              className="shrink-0 gap-0"
            >
              <TabsList aria-label={t("dashboard.range.label")}>
                {RANGE_OPTIONS.map((value) => (
                  <TabsTrigger key={value} value={value} className="h-6.5">
                    {t(`dashboard.range.${value}`)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <Select
              items={REFRESH_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
              value={autoRefresh}
              onValueChange={(value) => setAutoRefresh(String(value))}
            >
              <SelectTrigger size="sm" className="w-32" aria-label={t("dashboard.auto_refresh.label")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REFRESH_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void refetch()}
              disabled={!key || isFetching}
            >
              <RefreshCw className={cn(isFetching && "animate-spin")} />
              {t("common.refresh")}
            </Button>

            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-muted-foreground"
                    onClick={() => setKeyDialogOpen(true)}
                  />
                }
              >
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    key ? (unauthorized ? "bg-destructive" : "bg-success") : "bg-muted-foreground",
                  )}
                />
                <KeyRound className="size-3.5" />
                {t("dashboard.key.action")}
              </TooltipTrigger>
              <TooltipContent>
                {key
                  ? `${t("dashboard.key.status_connected")} · ${t("dashboard.key.source_label", {
                      source: t(`dashboard.key.source.${source}`),
                    })}`
                  : t("dashboard.key.status_missing")}
              </TooltipContent>
            </Tooltip>

            <DisplaySettings />
            <LanguageToggle />
            <ThemeToggle />
          </div>
          <PricingSource pricing={pricing} />
        </div>

        <TabsContent value="overview" className="space-y-4">
          {!loading && empty && (
            <Alert>
              <ChartColumn />
              <AlertTitle>{t("dashboard.empty.title")}</AlertTitle>
              <AlertDescription>{t("dashboard.empty.desc")}</AlertDescription>
            </Alert>
          )}
          <OverviewSummary summary={summary} loading={loading} pricing={pricing} />
        </TabsContent>

        <TabsContent value="records">
          <RecordsTab
            data={records}
            loading={loading}
            refreshing={refreshing}
            options={options}
            filters={filters}
            onFiltersChange={(next) => {
              setFilters(next);
              setPage(1);
            }}
            page={page}
            onPageChange={setPage}
            pageSize={pageSize}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
            pricing={pricing}
          />
        </TabsContent>

        <TabsContent value="storage">
          <StorageTab apiKey={key} />
        </TabsContent>
      </Tabs>

      <footer className="flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
        <span>{t("pricing.cost_is_estimate")}</span>
        {summary && <span>{t("records.count", { count: formatNumber(summary.total_requests) })}</span>}
      </footer>

      <KeyDialog
        open={keyDialogOpen}
        onOpenChange={(open) => {
          setKeyDialogOpen(open);
          if (!open) setSavingKey(false);
        }}
        hasKey={Boolean(key)}
        source={source}
        error={unauthorized ? t("dashboard.key.invalid") : ""}
        onSave={(next) => {
          setKey(next);
          setSavingKey(true);
        }}
        onClear={() => {
          clear();
          setSavingKey(false);
          setKeyDialogOpen(false);
        }}
      />
    </div>
  );
}
