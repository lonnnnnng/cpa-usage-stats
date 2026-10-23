import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/context";
import { type ModelPrice, type PriceSuggestion, removeCustomPrice, setCustomPrice } from "@/lib/pricing";

interface CustomPriceModalProps {
  open: boolean;
  modelName: string;
  currentPrice?: ModelPrice | null;
  /** 目录中最相近的模型，点选后填入其单价，仍可手动修改 */
  suggestions?: PriceSuggestion[];
  isCustom?: boolean;
  onClose: () => void;
  /** 价格写入本地后回调，用于让看板重新匹配成本 */
  onSaved: () => void;
}

interface FieldProps {
  id: string;
  label: string;
  placeholder: string;
  required?: boolean;
  value: string;
  onChange: (value: string) => void;
}

function PriceField({ id, label, placeholder, required, value, onChange }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={required ? undefined : "text-muted-foreground"}>
        {label}
        {required ? " *" : ""}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        step="any"
        min="0"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        className="font-mono"
      />
    </div>
  );
}

/** 自定义模型单价（美元 / 1M Tokens），保存在浏览器本地并优先于 models.dev。 */
export function CustomPriceModal({
  open,
  modelName,
  currentPrice,
  suggestions = [],
  isCustom = false,
  onClose,
  onSaved,
}: CustomPriceModalProps) {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [cacheRead, setCacheRead] = useState("");
  const [cacheWrite, setCacheWrite] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setInput(currentPrice ? String(currentPrice.input) : "");
    setOutput(currentPrice ? String(currentPrice.output) : "");
    setCacheRead(currentPrice?.cacheRead !== undefined ? String(currentPrice.cacheRead) : "");
    setCacheWrite(currentPrice?.cacheWrite !== undefined ? String(currentPrice.cacheWrite) : "");
    setReasoning(currentPrice?.reasoning !== undefined ? String(currentPrice.reasoning) : "");
    setError("");
  }, [open, currentPrice]);

  /** 点选相近模型只是填入单价，保存前仍可手动调整。 */
  const applySuggestion = (price: ModelPrice) => {
    setInput(String(price.input));
    setOutput(String(price.output));
    setCacheRead(price.cacheRead !== undefined ? String(price.cacheRead) : "");
    setCacheWrite(price.cacheWrite !== undefined ? String(price.cacheWrite) : "");
    setReasoning(price.reasoning !== undefined ? String(price.reasoning) : "");
    setError("");
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const inputPrice = Number.parseFloat(input);
    const outputPrice = Number.parseFloat(output);
    if (!Number.isFinite(inputPrice) || inputPrice < 0 || !Number.isFinite(outputPrice) || outputPrice < 0) {
      setError(t("pricing.dialog.invalid"));
      return;
    }

    const price: ModelPrice = { input: inputPrice, output: outputPrice };
    const cacheReadPrice = Number.parseFloat(cacheRead);
    if (Number.isFinite(cacheReadPrice) && cacheReadPrice >= 0) price.cacheRead = cacheReadPrice;
    const cacheWritePrice = Number.parseFloat(cacheWrite);
    if (Number.isFinite(cacheWritePrice) && cacheWritePrice >= 0) price.cacheWrite = cacheWritePrice;
    const reasoningPrice = Number.parseFloat(reasoning);
    if (Number.isFinite(reasoningPrice) && reasoningPrice >= 0) price.reasoning = reasoningPrice;

    setCustomPrice(modelName, price);
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("pricing.dialog.title")}</DialogTitle>
          <DialogDescription>{t("pricing.dialog.desc", { model: modelName })}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {suggestions.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-muted-foreground">{t("pricing.dialog.similar")}</Label>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((item) => (
                  <Button
                    key={item.modelId}
                    type="button"
                    variant="outline"
                    size="xs"
                    className="max-w-full font-mono"
                    title={item.modelId}
                    onClick={() => applySuggestion(item.price)}
                  >
                    <span className="truncate">{item.modelId}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <PriceField
              id="price-input"
              label={t("pricing.dialog.input")}
              placeholder={t("pricing.dialog.placeholder_required", { value: "3.00" })}
              required
              value={input}
              onChange={setInput}
            />
            <PriceField
              id="price-output"
              label={t("pricing.dialog.output")}
              placeholder={t("pricing.dialog.placeholder_required", { value: "15.00" })}
              required
              value={output}
              onChange={setOutput}
            />
            <PriceField
              id="price-cache-read"
              label={t("pricing.dialog.cache_read")}
              placeholder={t("pricing.dialog.placeholder_optional")}
              value={cacheRead}
              onChange={setCacheRead}
            />
            <PriceField
              id="price-cache-write"
              label={t("pricing.dialog.cache_write")}
              placeholder={t("pricing.dialog.placeholder_optional")}
              value={cacheWrite}
              onChange={setCacheWrite}
            />
            <div className="col-span-2">
              <PriceField
                id="price-reasoning"
                label={t("pricing.dialog.reasoning")}
                placeholder={t("pricing.dialog.reasoning_placeholder")}
                value={reasoning}
                onChange={setReasoning}
              />
            </div>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter className="gap-2">
            {isCustom && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  removeCustomPrice(modelName);
                  onSaved();
                  onClose();
                }}
              >
                {t("pricing.dialog.remove")}
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" size="sm">
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
