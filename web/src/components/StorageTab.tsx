import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database, Eraser, Recycle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useFormat } from "@/hooks/use-format";
import { useI18n } from "@/i18n/context";
import { clearStorage, fetchStorage, keyFingerprint, reclaimStorage } from "@/lib/api";
import { cn, formatBytes, formatDateTimeFull } from "@/lib/utils";
import type { StorageCleanupRange, StorageStats } from "@/types";

function StatCell({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-card p-4">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1.5 truncate font-mono text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-1 truncate text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function InfoRow({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 flex-1 truncate text-foreground", mono && "font-mono")} title={value}>
        {value}
      </dd>
    </div>
  );
}

/** 空间占用：数据库文件大小、记录范围、保留策略与手动回收。 */
export function StorageTab({ apiKey }: { apiKey: string }) {
  const { t } = useI18n();
  const { formatNumber } = useFormat();
  const queryClient = useQueryClient();
  const [reclaimOpen, setReclaimOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [cleanupRange, setCleanupRange] = useState<StorageCleanupRange>("today");

  const queryKey = ["usage-storage", keyFingerprint(apiKey)];
  const query = useQuery<StorageStats>({
    queryKey,
    enabled: Boolean(apiKey),
    queryFn: () => fetchStorage(apiKey),
    refetchOnWindowFocus: false,
  });

  const reclaim = useMutation({
    mutationFn: () => reclaimStorage(apiKey),
    onSuccess: (stats) => {
      const before = query.data?.total_size_bytes ?? 0;
      queryClient.setQueryData(queryKey, stats);
      setReclaimOpen(false);
      toast.success(t("storage.reclaimed", { size: formatBytes(Math.max(0, before - stats.total_size_bytes)) }));
    },
    onError: (error: Error) => {
      setReclaimOpen(false);
      toast.error(t("storage.reclaim_failed", { message: error.message }));
    },
  });

  const cleanup = useMutation({
    mutationFn: () => clearStorage(apiKey, cleanupRange),
    onSuccess: ({ deleted_records, stats }) => {
      queryClient.setQueryData(queryKey, stats);
      void queryClient.invalidateQueries({ queryKey: ["usage"] });
      setClearOpen(false);
      toast.success(t("storage.cleared", { count: formatNumber(deleted_records) }));
    },
    onError: (error: Error) => {
      setClearOpen(false);
      toast.error(t("storage.clear_failed", { message: error.message }));
    },
  });

  const busy = reclaim.isPending || cleanup.isPending;

  const data = query.data;
  const retention =
    data === undefined
      ? "-"
      : data.retention_days > 0
        ? t("storage.retention_value", { days: data.retention_days })
        : t("storage.retention_forever");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="gap-2">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <Database className="size-4 text-muted-foreground" />
                {t("storage.title")}
              </CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">{t("storage.desc")}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={!data || busy}
              onClick={() => setClearOpen(true)}
            >
              {busy ? <RefreshCw className="animate-spin" /> : <Eraser />}
              {busy ? t("storage.clearing") : t("storage.clear_data")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={!data || busy}
              onClick={() => setReclaimOpen(true)}
            >
              <Recycle />
              {t("storage.reclaim")}
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {query.isError ? (
            <Alert variant="destructive">
              <Database />
              <AlertTitle>{t("storage.load_failed", { message: (query.error as Error).message })}</AlertTitle>
            </Alert>
          ) : query.isPending || !data ? (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {["total", "db", "wal", "records"].map((key) => (
                <Skeleton key={key} className="h-20 w-full" />
              ))}
            </div>
          ) : (
            <>
              <div className="overflow-hidden rounded-lg bg-border ring-1 ring-foreground/10">
                <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-4">
                  <StatCell label={t("storage.total_size")} value={formatBytes(data.total_size_bytes)} />
                  <StatCell label={t("storage.db_size")} value={formatBytes(data.db_size_bytes)} />
                  <StatCell
                    label={t("storage.wal_size")}
                    value={formatBytes(data.wal_size_bytes)}
                    hint={t("storage.shm_size", { size: formatBytes(data.shm_size_bytes) })}
                  />
                  <StatCell label={t("storage.records")} value={formatNumber(data.record_count)} />
                </div>
              </div>

              <dl className="grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                <InfoRow label={t("storage.path")} value={data.db_path} />
                <InfoRow label={t("storage.retention")} value={retention} mono={false} />
                <InfoRow label={t("storage.oldest")} value={formatDateTimeFull(data.oldest_record_at)} />
                <InfoRow label={t("storage.newest")} value={formatDateTimeFull(data.newest_record_at)} />
                <InfoRow label={t("storage.reclaimable")} value={formatBytes(data.reclaimable_bytes)} />
              </dl>

              <div className="space-y-1 border-t pt-3 text-xs text-muted-foreground">
                <p>{t("storage.retention_hint")}</p>
                <p>{t("storage.reclaimable_hint")}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={clearOpen} onOpenChange={(open) => !busy && setClearOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("storage.clear_title")}</DialogTitle>
            <DialogDescription>{t("storage.clear_desc")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["today", "7d", "30d", "all"] as StorageCleanupRange[]).map((range) => (
              <Button
                key={range}
                variant={cleanupRange === range ? "default" : "outline"}
                className={cn(
                  range === "all" && cleanupRange === range && "bg-destructive text-white hover:bg-destructive/90",
                )}
                onClick={() => setCleanupRange(range)}
                disabled={busy}
              >
                {t(`storage.clear_${range}`)}
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button
              variant={cleanupRange === "all" ? "destructive" : "default"}
              onClick={() => cleanup.mutate()}
              disabled={busy}
            >
              {cleanup.isPending && <RefreshCw className="animate-spin" />}
              {cleanup.isPending ? t("storage.clearing") : t("storage.clear_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reclaimOpen} onOpenChange={(open) => !busy && setReclaimOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("storage.reclaim_title")}</DialogTitle>
            <DialogDescription>{t("storage.reclaim_desc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReclaimOpen(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => reclaim.mutate()} disabled={busy}>
              {reclaim.isPending && <RefreshCw className="animate-spin" />}
              {reclaim.isPending ? t("storage.reclaiming") : t("storage.reclaim_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
