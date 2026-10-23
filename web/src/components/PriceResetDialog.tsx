import { RotateCcw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useI18n } from "@/i18n/context";
import { listCustomPrices, type PricingTable, redundantCustomPriceKeys, removeCustomPrices } from "@/lib/pricing";
import { cn } from "@/lib/utils";

interface PriceResetDialogProps {
  open: boolean;
  table: PricingTable | null;
  onClose: () => void;
  /** 清理完成后的回调，参数为实际删除条数 */
  onDone: (removed: number) => void;
}

/** 两个清理范围都直接执行，弹窗本身就是确认步骤。 */
function ResetOption({
  title,
  description,
  count,
  destructive = false,
  onSelect,
}: {
  title: string;
  description: string;
  count: number;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={count === 0}
      onClick={onSelect}
      className={cn(
        "h-auto w-full flex-col items-start gap-1 px-3 py-2.5 text-left whitespace-normal",
        destructive && "hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      <span className={cn("flex w-full items-center gap-1.5 text-sm font-medium", destructive && "text-destructive")}>
        {destructive ? <Trash2 className="size-3.5" /> : <RotateCcw className="size-3.5" />}
        {title}
        <Badge variant="secondary" className="ml-auto font-mono tabular-nums">
          {count}
        </Badge>
      </span>
      <span className="text-xs font-normal text-muted-foreground">{description}</span>
    </Button>
  );
}

/** 重置价格匹配：清除本地自定义价，让模型回到 models.dev 目录匹配。 */
export function PriceResetDialog({ open, table, onClose, onDone }: PriceResetDialogProps) {
  const { t } = useI18n();
  const redundant = redundantCustomPriceKeys(table);
  const total = Object.keys(listCustomPrices()).length;

  const reset = (keys?: string[]) => {
    onDone(removeCustomPrices(keys));
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("pricing.reset.title")}</DialogTitle>
          <DialogDescription>{t("pricing.reset.desc")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <ResetOption
            title={t("pricing.reset.redundant")}
            description={t("pricing.reset.redundant_desc", { count: redundant.length })}
            count={redundant.length}
            onSelect={() => reset(redundant)}
          />
          <ResetOption
            title={t("pricing.reset.all")}
            description={t("pricing.reset.all_desc", { count: total })}
            count={total}
            destructive
            onSelect={() => reset()}
          />
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
