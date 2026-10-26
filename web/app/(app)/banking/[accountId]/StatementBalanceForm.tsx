"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Input, Label } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";
import { editableMoneyDecimal, sameMoneyDecimal } from "@/lib/exact-decimal";

/**
 * Opening/closing balances on an imported statement. A CSV carries no
 * bank-reported balances, so they start empty and stay editable until the
 * first match — the engine refuses matched and signed-off-history
 * statements with named remedies, surfaced here as the failure toast. A
 * blocked statement names its reason instead of offering edits that cannot
 * succeed.
 */
export function StatementBalanceForm({
  statementId,
  opening,
  closing,
  canEdit,
  blockedReason,
}: {
  statementId: string;
  opening: string | null;
  closing: string | null;
  canEdit: boolean;
  blockedReason: string | null;
}) {
  const t = useTranslations("banking.drawer");
  const tBanking = useTranslations("banking");
  const router = useRouter();
  // Stored balances arrive at numeric(19,4) padding; the fields show the
  // canonical amount so a 4-place zero tail never reads as a figure to edit.
  const [openingBalance, setOpeningBalance] = useState(editableMoneyDecimal(opening));
  const [closingBalance, setClosingBalance] = useState(editableMoneyDecimal(closing));
  const [busy, setBusy] = useState(false);

  if (!canEdit) {
    if (!blockedReason) return null;
    return <p className="text-xs text-slate-500 dark:text-slate-400">{blockedReason}</p>;
  }

  // Compared by exact amount: re-typing the same figure in another padding
  // is not an edit, so Save stays off until a balance actually moves.
  const unchanged =
    sameMoneyDecimal(openingBalance, opening) && sameMoneyDecimal(closingBalance, closing);

  async function save() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/banking/statements/${statementId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          openingBalance: openingBalance.trim() === "" ? null : openingBalance.trim(),
          closingBalance: closingBalance.trim() === "" ? null : closingBalance.trim(),
        }),
      });
      // The refusal reads through the shared helper so message, remedy and
      // code render instead of a bare fallback.
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, tBanking("errors.requestFailed")));
        return;
      }
      toast.success(t("balancesSaved"));
      router.refresh();
    } catch {
      toast.error(tBanking("errors.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-800">
      <p className="text-xs font-medium">{t("editBalancesTitle")}</p>
      <p className="text-xs text-slate-500 dark:text-slate-400">{t("editBalancesHelp")}</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label>{tBanking("labels.openingBalance")}</Label>
          <Input
            value={openingBalance}
            onChange={(e) => setOpeningBalance(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            aria-label={tBanking("labels.openingBalance")}
          />
        </div>
        <div className="space-y-1">
          <Label>{tBanking("labels.closingBalance")}</Label>
          <Input
            value={closingBalance}
            onChange={(e) => setClosingBalance(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
            aria-label={tBanking("labels.closingBalance")}
          />
        </div>
      </div>
      <Button variant="outline" size="sm" disabled={busy || unchanged} onClick={save}>
        {t("saveBalances")}
      </Button>
    </div>
  );
}
