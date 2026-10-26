"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";
import { promptDialog } from "@/lib/prompt";

/**
 * Withdraw one of the caller's own submissions while it awaits a decision,
 * through the subject's own withdrawal command (which verifies the requester
 * and the pending state). The reason is required and recorded. A refusal
 * pins beside the row until the next attempt, like a refused decision.
 * Nothing renders for a submission whose kind has no withdrawal.
 */
export function SubmissionWithdrawCell({
  endpoint,
  documentNumber,
}: {
  endpoint: string | null;
  documentNumber: string;
}) {
  const t = useTranslations("common");
  const ta = useTranslations("approvals");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  if (!endpoint) return null;
  async function withdraw() {
    if (!endpoint) return;
    const reason = await promptDialog({
      title: t("approvalFlow.withdrawTitle"),
      label: t("approvalFlow.withdrawReasonLabel"),
      confirmLabel: t("actions.withdrawSubmission"),
    });
    if (!reason) return;
    setBusy(true);
    setRefusal(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!res.ok) {
        const message = await readApiErrorMessage(res, t("approvalFlow.withdrawFailed"));
        setRefusal(message);
        toast.error(message);
        return;
      }
      toast.success(ta("submitted.withdrawn", { document: documentNumber }));
      router.refresh();
    } catch {
      setRefusal(t("approvalFlow.withdrawFailed"));
      toast.error(t("approvalFlow.withdrawFailed"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-col items-start gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={withdraw}>
        {t("actions.withdrawSubmission")}
      </Button>
      {refusal ? (
        <span
          role="alert"
          className="max-w-md rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {refusal}
        </span>
      ) : null}
    </span>
  );
}
