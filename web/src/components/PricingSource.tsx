import { ChevronDown, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PriceResetDialog } from "@/components/PriceResetDialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { PricingState } from "@/hooks/use-pricing";
import { useI18n } from "@/i18n/context";
import { listCustomPrices } from "@/lib/pricing";

/**
 * 价格来源说明。成本数字是按 models.dev 列表价折算的估算值，
 * 所以这里始终展示来源与更新时间，避免被当成账单。
 */
export function PricingSource({ pricing }: { pricing: PricingState }) {
  const { t } = useI18n();
  const { table, loading, error, refresh, reload } = pricing;
  const [resetOpen, setResetOpen] = useState(false);

  const updatedAt = useMemo(
    () =>
      table
        ? new Date(table.fetchedAt).toLocaleString(undefined, {
            hour12: false,
            dateStyle: "short",
            timeStyle: "short",
          })
        : "",
    [table],
  );

  // 自定义价存在 localStorage，改动后由 reload() 触发重渲染，这里直接读即可。
  const customCount = Object.keys(listCustomPrices()).length;

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <Sparkles className="size-3.5 shrink-0" />
      {loading ? (
        <span>{t("pricing.loading")}</span>
      ) : error && !table ? (
        <span className="font-medium text-destructive">{t("pricing.failed", { message: error })}</span>
      ) : (
        <span>
          {t("pricing.source")} <span className="font-medium text-foreground">{t("pricing.provider_name")}</span>
          {updatedAt && ` · ${updatedAt}`}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              disabled={loading}
              className="gap-1 text-muted-foreground hover:text-foreground"
            />
          }
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
          {t("pricing.manage")}
          <ChevronDown className="text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={refresh} disabled={loading}>
            <RefreshCw />
            {t("pricing.fetch")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setResetOpen(true)}>
            <RotateCcw />
            {t("pricing.reset.action")}
            {customCount > 0 && (
              <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{customCount}</span>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <PriceResetDialog
        open={resetOpen}
        table={table}
        onClose={() => setResetOpen(false)}
        onDone={(removed) => {
          reload();
          toast.success(t("pricing.reset.done", { count: removed }));
        }}
      />
    </div>
  );
}
