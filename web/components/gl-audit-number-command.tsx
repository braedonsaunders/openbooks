"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, SearchSelect } from "@openbooks/ui";
import { promptDialog } from "@/lib/prompt";
import { fetchAppAction } from "@/lib/api-error";
import { useAppAction } from "@/lib/use-app-action";
import { ActionError } from "@braedonsaunders/appkit-errors";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { z } from "zod";
import { toast } from "sonner";

export function GlAuditNumberCommand({
  bookId,
  periods,
  entities,
}: {
  bookId: string;
  periods: { value: string; label: string }[];
  entities: { value: string; label: string }[];
}) {
  const t = useTranslations("reports.journalMeasurements");
  const router = useRouter();
  const [periodId, setPeriodId] = useState(periods[0]?.value ?? "");
  const [subsidiaryId, setSubsidiaryId] = useState(entities[0]?.value ?? "");
  const { busy, refusal, execute, runExclusive } = useAppAction();
  const allocate = runExclusive(async () => {
    const reason = await promptDialog({
      title: t("allocateTitle"),
      message: t("allocateDescription"),
      label: t("reason"),
      placeholder: t("reason"),
    });
    if (!reason) return;
    await execute(
      async () => {
        const result = await fetchAppAction(
          "/api/close/gl-audit-numbers",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ periodId, subsidiaryId, bookId, reason }),
          },
          { fallback: t("failed") },
        );
        if (!result.ok) return result;
        const parsed = z
          .object({
            assigned: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
          })
          .refine((data) => data.total >= data.assigned)
          .safeParse(result.data);
        if (!parsed.success)
          return {
            ok: false,
            error: new ActionError({ kind: "unexpected", serverMessage: t("failed") }),
          };
        return { ...result, data: parsed.data };
      },
      {
        fallbackMessage: t("failed"),
        onOk: (data) => {
          toast.success(`${t("allocated")}: ${data.assigned}`);
          router.refresh();
        },
      },
    );
  });
  return (
    <div className="flex flex-wrap items-center gap-3">
      <SearchSelect
        value={periodId}
        onChange={setPeriodId}
        options={periods}
        placeholder={t("period")}
      />
      <SearchSelect
        value={subsidiaryId}
        onChange={setSubsidiaryId}
        options={entities}
        placeholder={t("entity")}
      />
      <Button variant="outline" disabled={busy || !periodId || !subsidiaryId} onClick={allocate}>
        {t("allocate")}
      </Button>
      {refusal ? (
        <div className="w-full">
          <ActionAlert error={refusal} fallbackMessage={t("failed")} />
        </div>
      ) : null}
    </div>
  );
}
