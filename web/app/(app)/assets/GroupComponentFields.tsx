"use client";
import { useTranslations } from "next-intl";
import { Button, Input, Label } from "@openbooks/ui";
import type { GroupComponentInput } from "@openbooks/engine/src/assets/group-component.ts";
/** Native field composition shared with the surrounding asset workpaper. */
export function GroupComponentFields({
  value,
  currency,
  onward,
  onChange,
}: {
  value?: GroupComponentInput;
  currency: string;
  onward: boolean;
  onChange: (value: GroupComponentInput) => void;
}) {
  const t = useTranslations("assets.groupComponent");
  const tCommon = useTranslations("common");
  const current: GroupComponentInput = value ?? {
    cost: "",
    accumulated: "",
    salvage: "",
    remainingPlan: [],
  };
  const set = (patch: Partial<GroupComponentInput>) =>
    onChange({ ...current, ...patch });
  const plan = (
    key:
      | "remainingPlan"
      | "removedPlan"
      | "unimpairedRemainingPlan"
      | "unimpairedRemovedPlan",
    label: string,
  ) => {
    const rows = current[key] ?? [];
    return (
      <fieldset className="space-y-2">
        <legend>{label}</legend>
        {rows.map((line, index) => (
          <div className="flex gap-2" key={index}>
            <Input
              type="date"
              aria-label={t("periodEnd", { label })}
              value={line.date}
              onChange={(e) =>
                set({
                  [key]: rows.map((r, i) =>
                    i === index ? { ...r, date: e.target.value } : r,
                  ),
                })
              }
            />
            <Input
              aria-label={t("planAmount", { label })}
              value={line.amount}
              onChange={(e) =>
                set({
                  [key]: rows.map((r, i) =>
                    i === index ? { ...r, amount: e.target.value } : r,
                  ),
                })
              }
            />
            <Button
              variant="outline"
              onClick={() => set({ [key]: rows.filter((_, i) => i !== index) })}
            >
              {tCommon("actions.remove")}
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          onClick={() => set({ [key]: [...rows, { date: "", amount: "" }] })}
        >
          {t("addCharge")}
        </Button>
      </fieldset>
    );
  };
  return (
    <fieldset className="space-y-3 rounded border p-3">
      <legend>{t("legend", { currency })}</legend>
      <p className="text-sm text-slate-500">{t("instructions")}</p>
      <div className="grid grid-cols-3 gap-3">
        {(
          [
            ["cost", t("cost")],
            ["accumulated", t("accumulated")],
            ["salvage", t("salvage")],
          ] as const
        ).map(([key, label]) => (
          <div key={key}>
            <Label>{label}</Label>
            <Input
              aria-label={label}
              value={current[key]}
              onChange={(e) => set({ [key]: e.target.value })}
            />
          </div>
        ))}
      </div>
      {plan("remainingPlan", t("retainedPlan"))}
      {onward ? plan("removedPlan", t("transferredPlan")) : null}
      <details>
        <summary>{t("impairmentTitle")}</summary>
        <p className="py-2 text-sm text-slate-500">{t("impairmentHelp")}</p>
        <Label>{t("unimpairedAccumulated")}</Label>
        <Input
          aria-label={t("unimpairedAccumulated")}
          value={current.unimpairedAccumulated ?? ""}
          onChange={(e) =>
            set({ unimpairedAccumulated: e.target.value || undefined })
          }
        />
        {plan("unimpairedRemainingPlan", t("unimpairedRetained"))}
        {onward ? plan("unimpairedRemovedPlan", t("unimpairedTransferred")) : null}
      </details>
    </fieldset>
  );
}
