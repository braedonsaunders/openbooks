"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@openbooks/ui";
import { toast } from "sonner";
import { readApiErrorMessage } from "@/lib/api-error";

/**
 * Single-row approval for a gateless submitted week. Posts the week's inbox
 * item to the shared inbox act route — the same native direct-approval path
 * the task list and the badge count — never a second approval service.
 */
export function TimesheetActions({ itemId }: { itemId: string }) {
  const t = useTranslations("approvals");
  const tc = useTranslations("common");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const router = useRouter();

  async function approve() {
    setBusy(true);
    setRefusal(null);
    try {
      const res = await fetch("/api/inbox/act", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, actionKey: "approve" }),
      });
      if (!res.ok) throw new Error(await readApiErrorMessage(res, t("decide.decisionFailed")));
      toast.success(tc("status.approved"));
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : t("decide.decisionFailed");
      setRefusal(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button size="sm" disabled={busy} onClick={approve}>
        {tc("actions.approve")}
      </Button>
      {refusal ? (
        <span role="alert" className="max-w-64 text-xs text-red-600 dark:text-red-400">
          {refusal}
        </span>
      ) : null}
    </span>
  );
}
