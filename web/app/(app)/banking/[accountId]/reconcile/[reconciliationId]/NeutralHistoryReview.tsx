"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { ApprovalActions, refreshApprovalState } from "@/components/approval-actions";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { ActionError, fetchAction } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Button } from "@openbooks/ui";
import { useMoney } from "@/components/money-provider";
import { useAppAction } from "@/lib/use-app-action";
import { promptDialog } from "@/lib/prompt";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { viewerDate } from "@/lib/format";

type Preview = {
  reconciliationId: string;
  throughDate: string;
  currency: string;
  statementBalance: string;
  proof: {
    digest: string;
    lateEntries: number;
    lateJournalLines: number;
    lateEffect: string;
    neutralBasis: "late_movements" | "outstanding_movements";
    outstandingEntries: number;
    outstandingJournalLines: number;
    outstandingEffect: string;
  };
};
function previewValue(value: unknown, id: string): Preview | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const proof =
    data.proof && typeof data.proof === "object" ? (data.proof as Record<string, unknown>) : null;
  if (
    data.reconciliationId !== id ||
    typeof data.throughDate !== "string" ||
    typeof data.currency !== "string" ||
    typeof data.statementBalance !== "string" ||
    canonicalDecimal(data.statementBalance, 4) === null ||
    !proof ||
    typeof proof.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(proof.digest) ||
    typeof proof.lateEntries !== "number" ||
    !Number.isSafeInteger(proof.lateEntries) ||
    proof.lateEntries < 1 ||
    typeof proof.lateJournalLines !== "number" ||
    !Number.isSafeInteger(proof.lateJournalLines) ||
    proof.lateJournalLines < proof.lateEntries ||
    typeof proof.lateEffect !== "string" ||
    canonicalDecimal(proof.lateEffect, 4) === null ||
    !["late_movements", "outstanding_movements"].includes(String(proof.neutralBasis)) ||
    (proof.neutralBasis === "late_movements" && canonicalDecimal(proof.lateEffect, 4) !== "0") ||
    (proof.neutralBasis === "outstanding_movements" &&
      (typeof proof.outstandingEffect !== "string" ||
        canonicalDecimal(proof.outstandingEffect, 4) !== "0" ||
        !Number.isSafeInteger(proof.outstandingEntries) ||
        Number(proof.outstandingEntries) < 1 ||
        !Number.isSafeInteger(proof.outstandingJournalLines) ||
        Number(proof.outstandingJournalLines) < Number(proof.lateJournalLines)))
  )
    return null;
  return data as Preview;
}

/** The existing late-entry panel supplies the individual movements. This
 * action first obtains the exact server review basis, then requests its
 * reasoned certificate through the same native command. */
export function NeutralHistoryReview({
  reconciliationId,
  disabled,
}: {
  reconciliationId: string;
  disabled: boolean;
}) {
  const t = useTranslations("banking.revalidation");
  const tc = useTranslations("common");
  const locale = useLocale();
  const action = useAppAction();
  const router = useRouter();
  const { money } = useMoney();
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const review = async () =>
    action.runExclusive(async () => {
      let preview: Preview | null = null;
      await action.execute(
        async () => {
          const result = await fetchAction(
            `/api/banking/reconciliations/${reconciliationId}/revalidate-sign-off`,
          );
          if (!result.ok) return result;
          const parsed = previewValue(result.data, reconciliationId);
          return parsed
            ? { ...result, data: parsed }
            : {
                ok: false,
                error: new ActionError({
                  kind: "refused",
                  serverMessage: t("failed"),
                }),
              };
        },
        {
          fallbackMessage: t("failed"),
          onOk: (data) => {
            preview = data;
          },
        },
      );
      if (!live.current || !preview) return;
      const current: Preview = preview;
      const reason = await promptDialog({
        title: t("title"),
        label: t("reason"),
        multiline: true,
        confirmLabel: t("confirm"),
        message:
          t("preview", {
            date: viewerDate(current.throughDate, locale, "UTC"),
            balance: money(current.statementBalance, {
              currency: current.currency,
            }),
            entries: current.proof.lateEntries,
            lines: current.proof.lateJournalLines,
          }) +
          (current.proof.neutralBasis === "outstanding_movements"
            ? " " +
              t("outstandingPreview", {
                entries: current.proof.outstandingEntries,
                lines: current.proof.outstandingJournalLines,
                amount: money(current.proof.outstandingEffect, {
                  currency: current.currency,
                }),
                lateAmount: money(current.proof.lateEffect, {
                  currency: current.currency,
                }),
              })
            : " " + t("latePreview")),
      });
      if (!live.current || reason === null) return;
      if (reason.trim().length < 10 || reason.trim().length > 500) {
        action.refuse(t("reasonRequired"), t("failed"));
        return;
      }
      await action.execute(
        async () => {
          const result = await fetchAction(
            `/api/banking/reconciliations/${reconciliationId}/revalidate-sign-off`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                expectedDigest: current.proof.digest,
                reason: reason.trim(),
              }),
            },
          );
          if (!result.ok) return result;
          const body = result.data as {
            status?: string;
            certificate?: { proof?: { digest?: unknown } };
            replayed?: unknown;
          } | null;
          return body?.status === "pending_approval" ||
            (body?.certificate?.proof?.digest === current.proof.digest &&
              typeof body.replayed === "boolean")
            ? result
            : {
                ok: false,
                error: new ActionError({
                  kind: "refused",
                  serverMessage: t("failed"),
                }),
              };
        },
        {
          fallbackMessage: t("failed"),
          onOk: (result) => {
            if (
              result &&
              typeof result === "object" &&
              "status" in result &&
              result.status === "pending_approval"
            )
              toast.info(tc("approvalFlow.submitted"));
            else toast.success(t("recorded"));
            refreshApprovalState();
            if (live.current) router.refresh();
          },
        },
      );
    })();
  return (
    <div className="mt-3 space-y-2">
      <ApprovalActions subjectKind="bank_reconciliation_review" subjectId={reconciliationId} />
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || action.busy}
        onClick={() => void review()}
      >
        {t("action")}
      </Button>
      <ActionAlert error={action.refusal} fallbackMessage={t("failed")} />
    </div>
  );
}
