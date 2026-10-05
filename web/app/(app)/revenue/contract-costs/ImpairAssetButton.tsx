"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Drawer, Input } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";
import { useMoney } from "@/components/money-provider";

/**
 * Recognize impairment: the write-down preview (carrying less recoverable)
 * shows before anything posts. Approval-gated at the route.
 */
export function ImpairAssetButton({
  assetId,
  currency,
  carrying,
}: {
  assetId: string;
  currency: string;
  carrying: string;
}) {
  const t = useTranslations("contractCosts");
  const { money } = useMoney();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState("");
  const [costs, setCosts] = useState("");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/revenue/contract-costs/impair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId,
          remainingConsideration: remaining,
          costsNotYetRecognized: costs || undefined,
          currency,
          reason,
          assessedOn: date,
        }),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("impair.failed")));
      const result = (await res.json()) as { posted: boolean; impairmentMinor: string };
      toast.success(
        result.posted ? t("impair.saved") : t("impair.clean"),
      );
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("impair.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t("impair.open")}
      </Button>
      {open && (
        <Drawer
          open
          onClose={() => setOpen(false)}
          title={t("impair.title")}
          description={t("impair.description", { carrying: money(carrying, { currency }) })}
        >
          <div className="space-y-4 p-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("impair.remaining", { currency })}</label>
              <Input value={remaining} onChange={(e) => setRemaining(e.target.value)} inputMode="decimal" placeholder="1000.00" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("impair.costs", { currency })}</label>
              <Input value={costs} onChange={(e) => setCosts(e.target.value)} inputMode="decimal" placeholder="0.00" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("impair.reason")}</label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t("impair.reasonHint")} />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">{t("impair.date")}</label>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={submit} disabled={busy || !remaining || reason.trim().length < 8 || !date}>
                {t("impair.submit")}
              </Button>
            </div>
          </div>
        </Drawer>
      )}
    </>
  );
}
