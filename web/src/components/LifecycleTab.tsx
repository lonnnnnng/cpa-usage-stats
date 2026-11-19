import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useFormat } from "@/hooks/use-format";
import { useI18n } from "@/i18n/context";
import { formatDateTimeFull, formatDuration } from "@/lib/utils";
import type { LifecycleEvent, LifecycleFilters, LifecycleListResponse, LifecycleOutcome } from "@/types";

const outcomes: LifecycleOutcome[] = ["succeeded", "failed", "rejected", "canceled"];

// 作者：long。只有同时收到开始和完成时间才展示耗时，缺终态不能推断仍在执行。
function duration(event: LifecycleEvent): number | null {
  if (!event.started_at || !event.completed_at) return null;
  const value = Date.parse(event.completed_at) - Date.parse(event.started_at);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function LifecycleTab({
  data,
  loading,
  refreshing,
  filters,
  onFiltersChange,
  page,
  onPageChange,
}: {
  data: LifecycleListResponse | null;
  loading: boolean;
  refreshing: boolean;
  filters: LifecycleFilters;
  onFiltersChange: (filters: LifecycleFilters) => void;
  page: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useI18n();
  const { formatNumber } = useFormat();
  const [draft, setDraft] = useState(filters);
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / (data?.page_size ?? 20)));
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{t("lifecycle.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("lifecycle.description")}</p>
      </div>
      <form
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_10rem_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          onFiltersChange({
            ...draft,
            requestId: draft.requestId.trim(),
            traceId: draft.traceId.trim(),
            model: draft.model.trim(),
          });
        }}
      >
        <Input
          aria-label={t("lifecycle.request_id")}
          placeholder={t("lifecycle.request_id")}
          value={draft.requestId}
          onChange={(event) => setDraft({ ...draft, requestId: event.target.value })}
        />
        <Input
          aria-label="Trace ID"
          placeholder="Trace ID"
          value={draft.traceId}
          onChange={(event) => setDraft({ ...draft, traceId: event.target.value })}
        />
        <Input
          aria-label={t("lifecycle.model_filter")}
          placeholder={t("lifecycle.model_filter")}
          value={draft.model}
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
        />
        <Select
          value={draft.outcome || "all"}
          items={[
            { value: "all", label: t("lifecycle.all") },
            ...outcomes.map((value) => ({ value, label: t(`lifecycle.${value}`) })),
          ]}
          onValueChange={(value) => setDraft({ ...draft, outcome: value === "all" ? "" : (value as LifecycleOutcome) })}
        >
          <SelectTrigger aria-label={t("lifecycle.outcome")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("lifecycle.all")}</SelectItem>
            {outcomes.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`lifecycle.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-2">
          <Button type="submit" size="sm">
            {t("common.search")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              const empty: LifecycleFilters = { requestId: "", traceId: "", model: "", outcome: "" };
              setDraft(empty);
              onFiltersChange(empty);
            }}
          >
            {t("lifecycle.reset")}
          </Button>
        </div>
      </form>
      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : data === null ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("lifecycle.not_loaded")}</p>
      ) : data.items.length ? (
        <Table aria-label={t("lifecycle.title")}>
          <TableHeader>
            <TableRow>
              <TableHead>{t("lifecycle.completed")}</TableHead>
              <TableHead>{t("lifecycle.outcome")}</TableHead>
              <TableHead>{t("lifecycle.model")}</TableHead>
              <TableHead>{t("lifecycle.duration")}</TableHead>
              <TableHead>{t("lifecycle.details")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((event) => {
              const elapsed = duration(event);
              return (
                <TableRow key={event.request_id}>
                  <TableCell className="align-top text-xs">
                    {formatDateTimeFull(event.completed_at ?? event.received_at)}
                    {!event.completed_at && (
                      <div className="text-muted-foreground">{t("lifecycle.received_fallback")}</div>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge
                      variant={event.outcome === "failed" || event.outcome === "rejected" ? "destructive" : "secondary"}
                    >
                      {t(`lifecycle.${event.outcome}`)}
                    </Badge>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {event.status_code > 0 ? `HTTP ${event.status_code}` : t("lifecycle.no_status")}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-72 whitespace-normal align-top text-xs">
                    <div className="break-all">{event.model || "—"}</div>
                    {event.requested_model && event.requested_model !== event.model && (
                      <div className="break-all text-muted-foreground">
                        {t("lifecycle.requested")}: {event.requested_model}
                      </div>
                    )}
                    <div className="mt-1 text-muted-foreground">
                      {event.source_format || "—"} ·{" "}
                      {event.stream ? t("records.detail.stream") : t("records.detail.non_stream")}
                    </div>
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs">
                    {elapsed === null ? "—" : formatDuration(elapsed)}
                  </TableCell>
                  <TableCell className="min-w-56 max-w-lg whitespace-normal align-top text-xs">
                    <details>
                      <summary className="cursor-pointer text-primary">{t("lifecycle.details")}</summary>
                      <dl className="mt-2 space-y-1 break-all">
                        <dt className="text-muted-foreground">{t("lifecycle.request_id")}</dt>
                        <dd className="select-text font-mono">{event.request_id}</dd>
                        <dt className="text-muted-foreground">Trace ID</dt>
                        <dd className="select-text font-mono">{event.trace_id || "—"}</dd>
                        <dt className="text-muted-foreground">{t("lifecycle.started")}</dt>
                        <dd>{formatDateTimeFull(event.started_at)}</dd>
                        <dt className="text-muted-foreground">{t("lifecycle.received")}</dt>
                        <dd>{formatDateTimeFull(event.received_at)}</dd>
                      </dl>
                      {event.error && (
                        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono">
                          {event.error}
                        </pre>
                      )}
                    </details>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">{t("lifecycle.empty")}</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {data ? (
            <>
              {t("lifecycle.count", { count: formatNumber(data.total) })} · {page} / {totalPages}
            </>
          ) : (
            "—"
          )}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" disabled={page <= 1 || refreshing} onClick={() => onPageChange(page - 1)}>
            {t("records.pagination.prev")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= totalPages || refreshing}
            onClick={() => onPageChange(page + 1)}
          >
            {t("records.pagination.next")}
          </Button>
        </div>
      </div>
    </div>
  );
}
