"use client";
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
              aria-label={`${label} period end`}
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
              aria-label={`${label} amount`}
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
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          onClick={() => set({ [key]: [...rows, { date: "", amount: "" }] })}
        >
          Add charge
        </Button>
      </fieldset>
    );
  };
  return (
    <fieldset className="space-y-3 rounded border p-3">
      <legend>Group component ({currency})</legend>
      <p className="text-sm text-slate-500">
        Use group amounts in the original transfer’s historical currency basis.
        Measure the disposed component separately from its legal-book amounts.
        Remaining plans allocate the retained carrying value less its residual
        value.
      </p>
      <div className="grid grid-cols-3 gap-3">
        {(
          [
            ["cost", "Group cost removed"],
            ["accumulated", "Group accumulated depreciation removed"],
            ["salvage", "Group residual value removed"],
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
      {plan("remainingPlan", "Retained group depreciation")}
      {onward
        ? plan("removedPlan", "Transferred component group depreciation")
        : null}
      <details>
        <summary>Prior group impairment: preserve the unimpaired basis</summary>
        <p className="py-2 text-sm text-slate-500">
          If an earlier impairment changed group service, supply the removed
          component’s accumulated depreciation and the retained future charges
          as they would have been without that impairment.
        </p>
        <Label>Removed component unimpaired accumulated depreciation</Label>
        <Input
          aria-label="Removed component unimpaired accumulated depreciation"
          value={current.unimpairedAccumulated ?? ""}
          onChange={(e) =>
            set({ unimpairedAccumulated: e.target.value || undefined })
          }
        />
        {plan(
          "unimpairedRemainingPlan",
          "Retained unimpaired group depreciation",
        )}
        {onward
          ? plan(
              "unimpairedRemovedPlan",
              "Transferred component unimpaired group depreciation",
            )
          : null}
      </details>
    </fieldset>
  );
}
