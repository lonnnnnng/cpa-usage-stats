import {
  AlertCircle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  Database,
  Layers,
  RotateCcw,
  Search,
  Sigma,
} from "lucide-react";
import { type MouseEvent, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationFirst,
  PaginationItem,
  PaginationLast,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFormat } from "@/hooks/use-format";
import type { PricingState } from "@/hooks/use-pricing";
import { useI18n } from "@/i18n/context";
import { cacheHitRatePercent, classifyRequestProtocol, recordLatencyTone, toneTextClass } from "@/lib/metrics";
import { type RecordCost, recordCost } from "@/lib/pricing";
import { cn, copyToClipboard, formatDateTimeFull, formatDuration, maskApiKey } from "@/lib/utils";
import type { OptionsResponse, RecordListResponse, RecordsFilters, StoredRecord } from "@/types";

interface RecordsTabProps {
  data: RecordListResponse | null;
  loading: boolean;
  refreshing?: boolean;
  options: OptionsResponse;
  filters: RecordsFilters;
  onFiltersChange: (filters: RecordsFilters) => void;
  page: number;
  onPageChange: (page: number) => void;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
  pageSizeOptions: number[];
  pricing: PricingState;
}

const EMPTY_FILTERS: RecordsFilters = {
  model: "",
  provider: "",
  apiKey: "",
  authId: "",
  sessionId: "",
  traceId: "",
  selectionId: "",
  status: "all",
  keyword: "",
};

const ROW_SKELETON_KEYS = ["row-a", "row-b", "row-c", "row-d", "row-e"];

/** base-ui Select 不接受空串作为选项值，这里用一个不会与真实值冲突的哨兵表示「全部」 */
const ALL_VALUE = "\u0000all";

/**
 * 筛选下拉。base-ui 的 SelectValue 需要 `items` 才能显示当前项标签，
 * 所以选项统一在这里构造，空串在边界处映射为「全部」。
 */
function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
  className?: string;
}) {
  const hasSelected = Boolean(value) && value !== ALL_VALUE && !options.some((o) => o.value === value);
  const items = [{ value: ALL_VALUE, label: allLabel }, ...(hasSelected ? [{ value, label: value }] : []), ...options];
  return (
    <Select
      items={items}
      value={value || ALL_VALUE}
      onValueChange={(next) => {
        if (next === null || next === undefined || next === ALL_VALUE) {
          onChange("");
        } else {
          onChange(String(next));
        }
      }}
    >
      <SelectTrigger className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** 单条字段：标签 + 值 + 复制。长值默认单行截断，完整内容交给原生 title。 */
function CostCell({ cost }: { cost: RecordCost | null }) {
  const { t } = useI18n();
  const { formatCost, formatUnitPrice } = useFormat();
  if (!cost) return <span className="text-muted-foreground">-</span>;

  const matchLabel =
    cost.match.matchType === "custom"
      ? t("pricing.match.custom")
      : cost.match.matchType === "fuzzy"
        ? t("pricing.match.fuzzy", { id: `${cost.match.providerId}/${cost.match.modelId}` })
        : t("pricing.match.exact", { id: `${cost.match.providerId}/${cost.match.modelId}` });

  return (
    <Tooltip>
      <TooltipTrigger render={<div className="cursor-help" />}>
        <div className="font-semibold">{formatCost(cost.cost)}</div>
        <div className="text-xs text-muted-foreground">
          {formatUnitPrice(cost.match.price.input)} / {formatUnitPrice(cost.match.price.output)}
        </div>
      </TooltipTrigger>
      <TooltipContent className="text-left">
        <div className="space-y-0.5">
          <div className="font-sans text-muted-foreground">{matchLabel}</div>
          <div className="font-mono tabular-nums">
            {t("pricing.breakdown.input")}: {formatCost(cost.breakdown.uncachedCost)}
          </div>
          <div className="font-mono tabular-nums">
            {t("pricing.breakdown.output")}: {formatCost(cost.breakdown.outputCost)}
          </div>
          {cost.breakdown.reasoningCost > 0 && (
            <div className="font-mono tabular-nums">
              {t("pricing.breakdown.reasoning")}: {formatCost(cost.breakdown.reasoningCost)}
            </div>
          )}
          {cost.breakdown.cacheReadCost > 0 && (
            <div className="font-mono tabular-nums">
              {t("pricing.breakdown.cache_read")}: {formatCost(cost.breakdown.cacheReadCost)}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function DetailRow({ record, cost }: { record: StoredRecord; cost: RecordCost | null }) {
  const { t } = useI18n();
  const { formatNumber, formatCost } = useFormat();
  const hasFailure = Boolean(record.failure_body) || Object.keys(record.response_headers ?? {}).length > 0;

  // 字段压成一行行的内联条目；长值截断并悬浮展示，避免每条记录展开后占据整屏
  const metaItems: { label: string; value: string; badge?: boolean }[] = [
    { label: t("records.detail.request_id"), value: record.request_id },
    { label: t("records.detail.trace_id"), value: record.trace_id },
    { label: "Selection ID", value: record.selection_id },
    { label: t("records.detail.session_id"), value: record.session_id },
    ...(record.parent_session_id
      ? [{ label: t("records.detail.parent_session"), value: record.parent_session_id }]
      : []),
    {
      label: t("records.detail.protocol"),
      value: t(
        `records.detail.protocol_${classifyRequestProtocol(record.provider, record.executor_type, record.source)}`,
      ),
      badge: true,
    },
    { label: t("records.detail.inbound_url"), value: t("records.detail.inbound_unavailable") },
    { label: t("records.detail.outbound_url"), value: record.base_url },
    {
      label: t("records.detail.auth"),
      value: [record.auth_id, record.auth_index && `#${record.auth_index}`, record.auth_type]
        .filter(Boolean)
        .join(" · "),
    },
    { label: t("records.detail.executor"), value: record.executor_type },
    { label: t("records.detail.source"), value: record.source },
    { label: t("records.detail.reasoning_effort"), value: record.reasoning_effort },
    {
      label: t("records.detail.service_tier"),
      value:
        [record.service_tier, record.effective_service_tier, record.response_service_tier]
          .filter(Boolean)
          .join(" → ") || "-",
    },
    {
      label: t("records.detail.mode"),
      value: [
        record.stream ? t("records.detail.stream") : t("records.detail.non_stream"),
        record.generate ? t("records.detail.generate") : t("records.detail.not_generate"),
      ].join(" · "),
    },
    ...(record.failed && record.error_type
      ? [{ label: t("records.detail.error_type"), value: record.error_type, badge: true }]
      : []),
    {
      label: t("records.detail.pricing_source"),
      value: cost
        ? `${cost.match.providerId}/${cost.match.modelId} (${cost.match.matchType})`
        : t("records.detail.unmatched"),
      badge: Boolean(cost),
    },
    {
      label: t("records.detail.auth_source"),
      value: record.is_native_key ? t("records.detail.native_key") : record.access_provider || "-",
      badge: record.is_native_key || Boolean(record.access_provider),
    },
  ];

  // 词元与费用压成一行 KV，与上面的元信息用一条分隔线区分
  const tokenItems: { label: string; value: string; emphasis?: boolean }[] = [
    { label: t("records.detail.token_input"), value: formatNumber(record.input_tokens) },
    { label: t("records.detail.token_output"), value: formatNumber(record.output_tokens) },
    ...(record.reasoning_tokens > 0
      ? [{ label: t("records.detail.token_reasoning"), value: formatNumber(record.reasoning_tokens) }]
      : []),
    ...(record.cache_read_tokens > 0
      ? [{ label: t("records.detail.token_cache_read"), value: formatNumber(record.cache_read_tokens) }]
      : []),
    ...(record.cache_creation_tokens > 0
      ? [{ label: t("records.detail.token_cache_write"), value: formatNumber(record.cache_creation_tokens) }]
      : []),
    ...(cacheHitRatePercent(
      record.input_tokens,
      record.cache_read_tokens,
      record.cache_creation_tokens,
      record.provider,
      record.executor_type,
      record.source,
    ) !== null
      ? [
          {
            label: t("records.detail.token_cache_rate"),
            value: `${cacheHitRatePercent(
              record.input_tokens,
              record.cache_read_tokens,
              record.cache_creation_tokens,
              record.provider,
              record.executor_type,
              record.source,
            )?.toFixed(1)}%`,
            emphasis: true,
          },
        ]
      : []),
    { label: t("records.detail.token_total"), value: formatNumber(record.total_tokens), emphasis: true },
    ...(cost ? [{ label: t("records.detail.estimate_label"), value: formatCost(cost.cost), emphasis: true }] : []),
  ];

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={7} className="whitespace-normal px-4 py-3">
        <div className="space-y-3">
          {/* 词元与费用放在最上方，保持一行，便于快速扫读 */}
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1.5">
            {tokenItems.map((item) => (
              <span key={item.label} className="inline-flex items-baseline gap-1 text-xs">
                <span className="text-muted-foreground">{item.label}</span>
                <span className={cn("font-mono tabular-nums", item.emphasis && "font-semibold text-primary")}>
                  {item.value}
                </span>
              </span>
            ))}
          </div>

          {/* 其余元信息一行一项，固定标签列让值左对齐 */}
          <div className="grid gap-1.5 border-t pt-2.5">
            {metaItems.map((item) => (
              <CompactItem key={item.label} label={item.label} value={item.value} badge={item.badge} />
            ))}
          </div>

          {hasFailure && (
            <details className="rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2">
              <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-destructive">
                <AlertCircle className="size-3.5" />
                {t("records.detail.failure_title", { status: record.status_code || 500 })}
              </summary>
              <div className="mt-2 space-y-2">
                {record.failure_body && (
                  <pre className="max-h-56 overflow-auto rounded-md bg-background p-2.5 font-mono text-xs whitespace-pre-wrap break-all">
                    {record.failure_body}
                  </pre>
                )}
                {record.response_headers && Object.keys(record.response_headers).length > 0 && (
                  <div className="flex flex-wrap gap-1.5 font-mono text-xs">
                    {Object.entries(record.response_headers).map(([name, values]) => (
                      <span
                        key={name}
                        className="inline-flex max-w-full min-w-0 items-baseline gap-1 rounded-md border bg-background px-2 py-0.5 whitespace-normal"
                      >
                        <span className="shrink-0 font-semibold">{name}:</span>
                        <span className="min-w-0 break-all text-muted-foreground">{values.join(", ")}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** 单行内联字段：标签在前、值在后，长值截断并保留完整内容供悬浮查看。 */
function CompactItem({ label, value, badge }: { label: string; value: string; badge?: boolean }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const text = value || "-";

  const handleCopy = async () => {
    if (!value || !(await copyToClipboard(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)_auto] items-baseline gap-2 text-xs sm:grid-cols-[11rem_minmax(0,1fr)_auto]">
      <span className="min-w-0 text-muted-foreground">{label}</span>
      {badge ? (
        <Badge variant="secondary" className="max-w-48 justify-self-start truncate font-mono font-normal">
          {text}
        </Badge>
      ) : (
        <span className="min-w-0 truncate font-mono text-foreground" title={text}>
          {text}
        </span>
      )}
      {value && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground hover:text-foreground"
          title={t("common.copy")}
          aria-label={t("common.copy")}
          onClick={handleCopy}
        >
          {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
        </Button>
      )}
    </div>
  );
}

export function RecordsTab({
  data,
  loading,
  refreshing = false,
  options,
  filters,
  onFiltersChange,
  page,
  onPageChange,
  pageSize,
  onPageSizeChange,
  pageSizeOptions,
  pricing,
}: RecordsTabProps) {
  const { t } = useI18n();
  const { formatNumber } = useFormat();
  const [expandedId, setExpandedId] = useState<number | null>(null);
  // 关键字与会话 ID 本地保留并防抖，避免每敲一个字就发一次查询
  const [keyword, setKeyword] = useState(filters.keyword);
  const [sessionId, setSessionId] = useState(filters.sessionId);
  const [traceId, setTraceId] = useState(filters.traceId);
  const [selectionId, setSelectionId] = useState(filters.selectionId);

  const [jumpPage, setJumpPage] = useState(String(page));

  useEffect(() => {
    setJumpPage(String(page));
  }, [page]);

  const handleJump = () => {
    const target = Number.parseInt(jumpPage, 10);
    if (!Number.isNaN(target) && target >= 1 && target <= totalPages) {
      if (target !== page) {
        onPageChange(target);
      }
    } else {
      setJumpPage(String(page));
    }
  };
  useEffect(() => {
    if (keyword === filters.keyword) return;
    const timer = setTimeout(() => onFiltersChange({ ...filters, keyword: keyword.trim() }), 300);
    return () => clearTimeout(timer);
  }, [keyword, filters, onFiltersChange]);

  useEffect(() => {
    if (sessionId === filters.sessionId) return;
    const timer = setTimeout(() => onFiltersChange({ ...filters, sessionId: sessionId.trim() }), 300);
    return () => clearTimeout(timer);
  }, [sessionId, filters, onFiltersChange]);

  useEffect(() => {
    if (traceId === filters.traceId) return;
    const timer = setTimeout(() => onFiltersChange({ ...filters, traceId: traceId.trim() }), 300);
    return () => clearTimeout(timer);
  }, [traceId, filters, onFiltersChange]);

  useEffect(() => {
    if (selectionId === filters.selectionId) return;
    const timer = setTimeout(() => onFiltersChange({ ...filters, selectionId: selectionId.trim() }), 300);
    return () => clearTimeout(timer);
  }, [selectionId, filters, onFiltersChange]);

  const setFilter = (patch: Partial<RecordsFilters>) => {
    onFiltersChange({ ...filters, ...patch });
    onPageChange(1);
  };

  const resetFilters = () => {
    setKeyword("");
    setSessionId("");
    setTraceId("");
    setSelectionId("");
    onFiltersChange(EMPTY_FILTERS);
    onPageChange(1);
  };

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const items = data?.items ?? [];
  const hasActiveFilters =
    Boolean(keyword.trim()) ||
    Boolean(sessionId.trim()) ||
    Boolean(traceId.trim()) ||
    Boolean(selectionId.trim()) ||
    Boolean(filters.model) ||
    Boolean(filters.provider) ||
    Boolean(filters.apiKey) ||
    Boolean(filters.authId) ||
    filters.status !== "all";

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Layers className="size-4 text-muted-foreground" />
              {t("records.title")}
            </CardTitle>
            <span className="text-xs text-muted-foreground">{t("records.count", { count: formatNumber(total) })}</span>
          </div>
          {hasActiveFilters && (
            <Button variant="ghost" size="xs" className="gap-1 text-muted-foreground" onClick={resetFilters}>
              <RotateCcw />
              {t("records.reset_filters")}
            </Button>
          )}
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder={t("records.search_placeholder")}
              aria-label={t("common.search")}
              className="pl-8"
            />
          </div>

          <Input
            value={traceId}
            onChange={(event) => setTraceId(event.target.value)}
            placeholder="Trace ID"
            aria-label="Trace ID"
            className="font-mono text-xs"
          />

          <Input
            value={selectionId}
            onChange={(event) => setSelectionId(event.target.value)}
            placeholder="Selection ID"
            aria-label="Selection ID"
            className="font-mono text-xs"
          />

          <FilterSelect
            value={filters.model}
            onChange={(value) => setFilter({ model: value })}
            allLabel={t("records.filter.model_all")}
            options={options.models.map((model) => ({ value: model, label: model }))}
            className="w-full"
          />

          <FilterSelect
            value={filters.provider}
            onChange={(value) => setFilter({ provider: value })}
            allLabel={t("records.filter.provider_all")}
            options={options.providers.map((provider) => ({ value: provider, label: provider }))}
            className="w-full"
          />

          <FilterSelect
            value={filters.apiKey}
            onChange={(value) => setFilter({ apiKey: value })}
            allLabel={t("records.filter.key_all")}
            options={options.api_keys.map((key) => ({ value: key, label: maskApiKey(key) }))}
            className="w-full"
          />

          <FilterSelect
            value={filters.authId}
            onChange={(value) => setFilter({ authId: value })}
            allLabel={t("records.filter.auth_all")}
            options={options.auths.map((auth) => ({ value: auth, label: auth }))}
            className="w-full"
          />

          <div className="relative">
            <Input
              value={sessionId}
              onChange={(event) => setSessionId(event.target.value)}
              placeholder={t("records.filter.session_placeholder")}
              aria-label={t("records.filter.session_placeholder")}
              className="font-mono text-xs"
            />
          </div>

          <FilterSelect
            value={filters.status === "all" ? "" : filters.status}
            onChange={(value) => setFilter({ status: (value || "all") as RecordsFilters["status"] })}
            allLabel={t("records.filter.status_all")}
            options={[
              { value: "success", label: t("records.filter.status_success") },
              { value: "failed", label: t("records.filter.status_failed") },
            ]}
            className="w-full"
          />
        </div>
      </CardHeader>

      <CardContent className="px-0">
        {!loading && items.length === 0 ? (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Search />
              </EmptyMedia>
              <EmptyTitle>{t("records.empty")}</EmptyTitle>
              <EmptyDescription>{t("dashboard.empty.desc")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="relative" aria-busy={refreshing}>
            <Table className="min-w-[1120px] table-fixed">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44 pl-4">{t("records.th.time")}</TableHead>
                  <TableHead className="w-52">{t("records.th.model")}</TableHead>
                  <TableHead className="w-72">{t("records.th.source")}</TableHead>
                  <TableHead className="w-48">{t("records.th.tokens")}</TableHead>
                  <TableHead className="w-32 text-right">{t("records.th.cache_rate")}</TableHead>
                  <TableHead className="w-32 text-right">{t("records.th.cost")}</TableHead>
                  <TableHead className="w-40 pr-4 text-right">{t("records.th.latency")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading
                  ? ROW_SKELETON_KEYS.map((rowKey) => (
                      <TableRow key={rowKey}>
                        <TableCell colSpan={7} className="px-4">
                          <Skeleton className="h-5 w-full" />
                        </TableCell>
                      </TableRow>
                    ))
                  : items.map((record) => {
                      const expanded = expandedId === record.id;
                      const cost = recordCost(pricing.table, record);
                      const generationMs = record.ttft_ms > 0 ? record.latency_ms - record.ttft_ms : record.latency_ms;
                      const throughput =
                        generationMs > 100 && record.output_tokens > 0
                          ? (record.output_tokens / (generationMs / 1000)).toFixed(1)
                          : null;

                      return (
                        <RecordRows
                          key={record.id}
                          record={record}
                          cost={cost}
                          expanded={expanded}
                          throughput={throughput}
                          onToggle={() => setExpandedId(expanded ? null : record.id)}
                        />
                      );
                    })}
              </TableBody>
            </Table>
            {refreshing && (
              <>
                <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 animate-pulse bg-primary/70" />
                <span className="sr-only" role="status">
                  {t("common.refresh")}
                </span>
              </>
            )}
          </div>
        )}

        {total > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
            <span className="text-xs text-muted-foreground">
              {t("records.pagination.summary", { page, pages: totalPages, size: pageSize })}
            </span>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t("records.pagination.page_size")}</span>
                <Select
                  items={pageSizeOptions.map((size) => ({ value: String(size), label: String(size) }))}
                  value={String(pageSize)}
                  onValueChange={(value) => value && onPageSizeChange(Number(value))}
                >
                  <SelectTrigger size="sm" className="w-18" aria-label={t("records.pagination.page_size")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pageSizeOptions.map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t("records.pagination.jump")}</span>
                <Input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={jumpPage}
                  onChange={(e) => setJumpPage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleJump();
                    }
                  }}
                  onBlur={handleJump}
                  className="h-7 w-14 px-1 text-center font-mono text-xs tabular-nums"
                  aria-label={t("records.pagination.jump")}
                />
                <span>{t("records.pagination.page_unit")}</span>
              </div>
              <Pagination className="mx-0 w-auto justify-end">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationFirst
                      text={t("records.pagination.first")}
                      aria-label={t("records.pagination.first")}
                      aria-disabled={page <= 1}
                      className={cn(page <= 1 && "pointer-events-none opacity-50")}
                      onClick={() => page > 1 && onPageChange(1)}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationPrevious
                      text={t("records.pagination.prev")}
                      aria-label={t("records.pagination.prev")}
                      aria-disabled={page <= 1}
                      className={cn(page <= 1 && "pointer-events-none opacity-50")}
                      onClick={() => page > 1 && onPageChange(page - 1)}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <span className="px-2 font-mono text-xs tabular-nums">
                      {page} / {totalPages}
                    </span>
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext
                      text={t("records.pagination.next")}
                      aria-label={t("records.pagination.next")}
                      aria-disabled={page >= totalPages}
                      className={cn(page >= totalPages && "pointer-events-none opacity-50")}
                      onClick={() => page < totalPages && onPageChange(page + 1)}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationLast
                      text={t("records.pagination.last")}
                      aria-label={t("records.pagination.last")}
                      aria-disabled={page >= totalPages}
                      className={cn(page >= totalPages && "pointer-events-none opacity-50")}
                      onClick={() => page < totalPages && onPageChange(totalPages)}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RecordRows({
  record,
  cost,
  expanded,
  throughput,
  onToggle,
}: {
  record: StoredRecord;
  cost: RecordCost | null;
  expanded: boolean;
  throughput: string | null;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const { formatNumber } = useFormat();
  const protocol = classifyRequestProtocol(record.provider, record.executor_type, record.source);
  const protocolLabel = t(`records.row.protocol_${protocol}`);
  const cacheRate = cacheHitRatePercent(
    record.input_tokens,
    record.cache_read_tokens,
    record.cache_creation_tokens,
    record.provider,
    record.executor_type,
    record.source,
  );
  const aliasNote =
    (record.alias && record.alias !== record.model) || (record.response_model && record.response_model !== record.model)
      ? [
          record.alias && record.alias !== record.model ? t("records.row.alias", { name: record.alias }) : "",
          record.response_model && record.response_model !== record.model
            ? t("records.row.upstream", { name: record.response_model })
            : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
  const modeLabel = [
    record.stream ? t("records.detail.stream") : t("records.detail.non_stream"),
    record.generate ? t("records.detail.generate") : t("records.detail.not_generate"),
  ].join(" · ");

  return (
    <>
      <TableRow
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onToggle();
        }}
        aria-expanded={expanded}
        className={cn(
          "cursor-pointer",
          record.failed ? "bg-destructive/10 hover:bg-destructive/15" : "hover:bg-muted/40",
          "aria-expanded:bg-muted/40",
        )}
      >
        <TableCell className="w-44 py-3 pl-4 font-mono text-xs text-muted-foreground">
          <div className="space-y-1">
            <div className="truncate whitespace-nowrap" title={formatDateTimeFull(record.requested_at)}>
              {formatDateTimeFull(record.requested_at)}
            </div>
            <Badge
              variant={record.failed ? "destructive" : "secondary"}
              className={cn(
                "w-fit max-w-full truncate border text-[11px] font-normal",
                !record.failed && "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
              )}
              title={String(record.status_code || (record.failed ? 500 : 200))}
            >
              {record.failed ? t("records.row.status_failed") : t("records.row.status_success")}
            </Badge>
          </div>
        </TableCell>
        <TableCell className="w-52 py-3 font-medium">
          <div className="min-w-0 space-y-0.5 text-xs">
            <span className="block truncate text-sm" title={record.model}>
              {record.model}
            </span>
            <span className="block truncate text-muted-foreground" title={record.reasoning_effort || undefined}>
              {record.reasoning_effort || "-"}
            </span>
            <span className="block truncate text-muted-foreground" title={modeLabel}>
              {modeLabel}
            </span>
            {aliasNote && <span className="sr-only">{aliasNote}</span>}
          </div>
        </TableCell>
        <TableCell className="w-72 py-3 font-mono text-xs text-muted-foreground">
          <div className="min-w-0 space-y-0.5">
            <CopyableLine parts={[{ text: record.provider || "-", copyValue: record.provider }]} />
            <CopyableLine parts={[{ text: record.base_url || "-", copyValue: record.base_url }]} />
            <CopyableLine parts={[{ text: record.source || "-", copyValue: record.source }]} />
          </div>
        </TableCell>
        <TableCell className="w-48 py-2 font-mono tabular-nums">
          <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
            <TokenMetric
              icon={ArrowDownToLine}
              label={t("records.row.token_input")}
              value={record.input_tokens}
              className="text-sky-600 dark:text-sky-400"
              formatNumber={formatNumber}
            />
            <TokenMetric
              icon={ArrowUpFromLine}
              label={t("records.row.token_output")}
              value={record.output_tokens}
              className="text-violet-600 dark:text-violet-400"
              formatNumber={formatNumber}
            />
            <TokenMetric
              icon={Database}
              label={t("records.row.token_cache")}
              value={record.cached_tokens}
              className="text-amber-600 dark:text-amber-400"
              formatNumber={formatNumber}
            />
            <TokenMetric
              icon={Sigma}
              label={t("records.row.token_total")}
              value={record.total_tokens}
              className="font-semibold text-foreground"
              formatNumber={formatNumber}
            />
          </div>
        </TableCell>
        <TableCell className="w-32 py-3 text-right font-mono text-xs tabular-nums">
          <div className="space-y-1">
            <div>{cacheRate === null ? "-" : `${cacheRate.toFixed(1)}%`}</div>
            <Badge variant="outline" className="max-w-full truncate text-[10px] font-normal" title={protocolLabel}>
              {protocolLabel}
            </Badge>
          </div>
        </TableCell>
        <TableCell className="w-32 py-3 whitespace-nowrap text-right font-mono tabular-nums">
          <CostCell cost={cost} />
        </TableCell>
        <TableCell className="w-40 py-3 pr-4 whitespace-nowrap text-right font-mono tabular-nums">
          <div className="space-y-1 text-xs">
            <div
              className={cn(
                "flex items-center justify-end gap-1",
                toneTextClass(recordLatencyTone(record.ttft_ms > 0 ? record.ttft_ms : null)),
              )}
            >
              <span className="text-muted-foreground">{t("records.row.first_token")}</span>
              <span>{record.ttft_ms > 0 ? formatDuration(record.ttft_ms) : "-"}</span>
            </div>
            <div
              className={cn("flex items-center justify-end gap-1", toneTextClass(recordLatencyTone(record.latency_ms)))}
            >
              <span className="text-muted-foreground">{t("records.row.total_duration")}</span>
              <span>{record.latency_ms > 0 ? formatDuration(record.latency_ms) : "-"}</span>
            </div>
            <div className="flex items-center justify-end gap-1 text-muted-foreground">
              <span>{t("records.row.output_tps")}</span>
              <span>{throughput ? t("records.row.throughput", { value: throughput }) : "-"}</span>
            </div>
          </div>
        </TableCell>
      </TableRow>
      {expanded && <DetailRow record={record} cost={cost} />}
    </>
  );
}

function TokenMetric({
  icon: Icon,
  label,
  value,
  className,
  formatNumber,
}: {
  icon: typeof ArrowDownToLine;
  label: string;
  value: number;
  className: string;
  formatNumber: (value: number) => string;
}) {
  return (
    <span
      className={cn("inline-flex min-w-0 items-center justify-start gap-1 overflow-hidden", className)}
      title={label}
    >
      <Icon className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate">{formatNumber(value)}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function CopyableLine({ parts }: { parts: { text: string; copyValue?: string }[] }) {
  const { t } = useI18n();

  return (
    <div className="group flex min-w-0 items-center gap-1">
      {parts.map((part) => (
        <CopyablePart key={`${part.copyValue ?? "text"}:${part.text}`} part={part} copyLabel={t("common.copy")} />
      ))}
    </div>
  );
}

function CopyablePart({ part, copyLabel }: { part: { text: string; copyValue?: string }; copyLabel: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!part.copyValue || !(await copyToClipboard(part.copyValue))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <span className="group/part inline-flex min-w-0 items-center gap-0.5">
      <span className="min-w-0 truncate" title={part.text}>
        {part.text}
      </span>
      {part.copyValue && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/part:opacity-100 focus:opacity-100"
          title={copyLabel}
          aria-label={copyLabel}
          onClick={handleCopy}
        >
          {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
        </Button>
      )}
    </span>
  );
}
