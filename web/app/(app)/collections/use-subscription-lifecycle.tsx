"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@openbooks/ui";
import { fetchAction } from "@braedonsaunders/appkit-errors";
import { useAppAction } from "@/lib/use-app-action";
import { promptDialog } from "@/lib/prompt";
import { useBusinessToday } from "@/components/business-date-provider";
import { useMoney } from "@/components/money-provider";
import { CatchUpPickerDialog, type CatchUpPick } from "./CatchUpPickerDialog";
import type { SubscriptionDrawerData } from "./subscription-drawer";

type CatchUpPreview = { periods: string[]; estimatedTotal: string; currency: string | null };
type Result = {
  invoiceId?: string;
  documentNumber?: string;
  adjustment?: string;
  catchUp?: { results?: { status?: string }[]; stopped?: string; error?: string };
};

/** All subscription entry points use the same native commands and explicit catch-up choice. */
export function useSubscriptionLifecycle(
  drawer: SubscriptionDrawerData,
  onChanged: () => Promise<void>,
  disabled = false,
) {
  const t = useTranslations("ar.collections.subscriptions");
  const errors = useTranslations("ar.collections.errors");
  const common = useTranslations("common");
  const today = useBusinessToday();
  const { money } = useMoney();
  const action = useAppAction();
  const [preview, setPreview] = useState<CatchUpPreview | null>(null);
  async function post(payload: Record<string, unknown>) {
    let body: Result | null = null;
    const ok = await action.execute(
      async () => {
        const result = await fetchAction<Result>("/api/subscriptions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...payload, id: drawer.id }),
        });
        if (result.ok) body = result.data;
        return result;
      },
      { fallbackMessage: errors("actionFailed"), onOk: onChanged },
    );
    return ok ? (body as Result | null) : null;
  }
  function reportCatchUp(result: Result) {
    const outcome = result.catchUp;
    if (!outcome) return;
    if (outcome.stopped === "failed") {
      action.refuse(outcome.error, errors("actionFailed"));
      return;
    }
    const counts = { posted: 0, draft: 0, skipped: 0 };
    for (const row of outcome.results ?? [])
      if (row.status === "posted" || row.status === "draft" || row.status === "skipped")
        counts[row.status]++;
    toast.success(
      t("catchUpDone", {
        posted: String(counts.posted),
        drafts: String(counts.draft),
        skipped: String(counts.skipped),
      }),
    );
  }
  const resume = action.runExclusive(async () => {
    const result = await fetchAction<CatchUpPreview>(
      `/api/subscriptions/preview?subscriptionId=${encodeURIComponent(drawer.id)}`,
    );
    if (!result.ok) {
      action.refuse(result.error.displayMessage(errors("actionFailed")), errors("actionFailed"));
      return;
    }
    if (result.data.periods.length < 2) {
      const resumed = await post({ action: "updateSubscription", status: "active" });
      if (resumed) reportCatchUp(resumed);
    } else setPreview(result.data);
  });
  const changeQuantity = action.runExclusive(async () => {
    const quantity = await promptDialog({
      title: t("changeQty"),
      label: t("subsTable.qty"),
      initialValue: drawer.quantity,
      confirmLabel: t("apply"),
    });
    if (quantity === null) return;
    const result = await post({ action: "changeSubscription", quantity });
    if (result)
      toast.success(
        result.documentNumber
          ? t("toasts.prorated", {
              adjustment: money(result.adjustment, { currency: drawer.currency }),
              documentNumber: result.documentNumber,
            })
          : t("toasts.qtyUpdatedNoProration"),
      );
  });
  const cancel = action.runExclusive(async () => {
    const canceledOn = await promptDialog({
      title: t("cancelConfirmTitle"),
      message: `${t("cancelConfirmBody")} ${t("cancelPaidThroughHint", { date: drawer.paidThroughOn })}`,
      label: t("cancelEffectiveOn"),
      kind: "date",
      businessToday: today,
      initialValue: drawer.paidThroughOn,
      confirmLabel: t("cancelSubscription"),
      cancelLabel: t("keepSubscription"),
    });
    if (canceledOn !== null)
      await post({ action: "updateSubscription", status: "canceled", canceledOn });
  });
  async function pick(choice: CatchUpPick) {
    const result = await post({ action: "updateSubscription", status: "active", catchUp: choice });
    if (result) {
      setPreview(null);
      reportCatchUp(result);
    }
  }
  const busy = disabled || action.busy;
  return {
    busy,
    actions: drawer.canManage ? (
      <>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            const result = await post({ action: "billNow" });
            if (result?.invoiceId && result.documentNumber)
              toast.success(t("toasts.billed", { documentNumber: result.documentNumber }));
          }}
        >
          {t("billNow")}
        </Button>
        {drawer.status === "active" && !drawer.advancedLifecycle ? (
          <Button variant="ghost" disabled={busy} onClick={() => void changeQuantity()}>
            {t("changeQty")}
          </Button>
        ) : null}
        {drawer.status === "active" ? (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void post({ action: "updateSubscription", status: "paused" })}
          >
            {t("pause")}
          </Button>
        ) : drawer.status === "paused" ? (
          <Button variant="ghost" disabled={busy} onClick={() => void resume()}>
            {t("resume")}
          </Button>
        ) : null}
        {drawer.status !== "canceled" ? (
          <Button variant="ghost" disabled={busy} onClick={() => void cancel()}>
            {t("cancelSub")}
          </Button>
        ) : null}
      </>
    ) : null,
    refusal: action.refusal?.displayMessage(errors("actionFailed")),
    panel: (
      <CatchUpPickerDialog
        error={action.refusal?.displayMessage(errors("actionFailed"))}
        open={preview !== null}
        title={t("catchUpTitle")}
        message={
          preview
            ? t("catchUpResumeMessage", {
                count: String(preview.periods.length),
                total: `${preview.estimatedTotal} ${preview.currency ?? ""}`.trim(),
              })
            : ""
        }
        selectHint={t("catchUpSelectHint")}
        dates={preview?.periods ?? []}
        postSelectedLabel={t("catchUpSelectedPost")}
        draftSelectedLabel={t("catchUpSelectedDrafts")}
        postAllLabel={t("catchUpPostAll")}
        draftsLabel={t("catchUpDrafts")}
        skipLabel={t("catchUpSkip")}
        cancelLabel={common("confirm.cancel")}
        busy={busy}
        onPick={(choice) => void pick(choice)}
        onClose={() => setPreview(null)}
      />
    ),
  };
}
