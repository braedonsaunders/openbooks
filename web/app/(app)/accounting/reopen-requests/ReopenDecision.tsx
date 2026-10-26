"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { fetchAppAction } from "@/lib/api-error";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Button } from "@openbooks/ui";
import { ApprovalActions } from "@/components/approval-actions";
import { useAppAction } from "@/lib/use-app-action";
import { promptDialog } from "@/lib/prompt";

/** Requesters may withdraw; all reviewer decisions use the native Flow gates. */
export function ReopenDecision({
  requestId,
  ownRequest,
}: {
  requestId: string;
  ownRequest: boolean;
}) {
  const t = useTranslations("accounting.reopenRequests");
  const router = useRouter();
  const { busy, refusal, execute } = useAppAction();
  async function withdraw() {
    const reason = await promptDialog({
      title: t("withdrawReasonTitle"),
      message: t("reasonHint"),
      label: t("reasonLabel"),
      multiline: true,
      confirmLabel: t("withdraw"),
    });
    if (reason === null) return;
    const ok = await execute(
      () =>
        fetchAppAction(
          "/api/admin/close",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "withdraw-reopen",
              requestId,
              reason,
            }),
          },
          { fallback: t("withdrawFailed") },
        ),
      { fallbackMessage: t("withdrawFailed") },
    );
    if (ok) router.refresh();
  }
  return (
    <div className="space-y-2">
      <ActionAlert error={refusal} fallbackMessage={t("withdrawFailed")} />
      <div className="flex flex-wrap items-center gap-2">
        <ApprovalActions
          subjectKind="close_reopen_request"
          subjectId={requestId}
          submitApprovalHref={ownRequest ? `/api/close/reopens/${requestId}/submit` : undefined}
          submissionStatuses={["requested"]}
        />
        {ownRequest ? (
          <Button variant="outline" disabled={busy} onClick={() => void withdraw()}>
            {t("withdraw")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
