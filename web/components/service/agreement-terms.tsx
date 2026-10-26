"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Label, Select, Textarea } from "@openbooks/ui";
import { DateField } from "../date-field";
import { LinesEditor, QualificationPicker, lineInputs, newLine, type DraftLine } from "./pickers";

export type AgreementTerms = {
  recurrence: {
    repeat: "daily" | "weekly" | "monthly" | "yearly";
    interval: number;
    weekdays?: number[];
    monthlyBy?: "day" | "weekday";
  };
  windowStarts: string;
  windowEnds: string;
  estimatedMinutes: number;
  priority: string;
  requiredQualificationTypeIds: string[];
  instructions: string | null;
  lines: ReturnType<typeof lineInputs>;
};

type Initial = {
  recurrence: unknown;
  windowStarts: string;
  windowEnds: string;
  estimatedMinutes: number;
  priority: string;
  requiredQualificationTypeIds: readonly string[];
  instructions: string | null;
  lines: readonly {
    itemId: string;
    itemName: string;
    description: string | null;
    quantity: string;
    unitPrice: string;
  }[];
};

/** How often an agreement's visit recurs, its arrival window, length, skills and billed lines. */
export function AgreementTermsForm({
  initial,
  withEffectiveDate,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  initial?: Initial;
  withEffectiveDate?: boolean;
  onSubmit: (
    terms: AgreementTerms & { effectiveFrom: string; reason: string },
  ) => Promise<void> | void;
  onCancel?: () => void;
  submitLabel?: string;
}) {
  const t = useTranslations("service.form");
  const rule = (initial?.recurrence ?? {}) as Partial<AgreementTerms["recurrence"]>;
  const [repeat, setRepeat] = useState<AgreementTerms["recurrence"]["repeat"]>(
    rule.repeat ?? "monthly",
  );
  const [interval, setRepeatInterval] = useState(String(rule.interval ?? 1));
  const [weekdays, setWeekdays] = useState<number[]>(rule.weekdays ?? []);
  const [monthlyBy, setMonthlyBy] = useState<"day" | "weekday">(rule.monthlyBy ?? "day");
  const [windowStarts, setWindowStarts] = useState(initial?.windowStarts ?? "08:00");
  const [windowEnds, setWindowEnds] = useState(initial?.windowEnds ?? "12:00");
  const [minutes, setMinutes] = useState(String(initial?.estimatedMinutes ?? 60));
  const [priority, setPriority] = useState(initial?.priority ?? "normal");
  const [skills, setSkills] = useState<string[]>([
    ...(initial?.requiredQualificationTypeIds ?? []),
  ]);
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [lines, setLines] = useState<DraftLine[]>(
    initial?.lines.length
      ? initial.lines.map((line) => ({
          key: crypto.randomUUID(),
          itemId: line.itemId,
          itemLabel: line.itemName,
          description: line.description ?? "",
          quantity: line.quantity,
          unitPrice: line.unitPrice,
        }))
      : [newLine()],
  );
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const valid =
    /^\d+$/.test(interval.trim()) &&
    /^\d+$/.test(minutes.trim()) &&
    (!withEffectiveDate || Boolean(effectiveFrom)) &&
    reason.trim().length > 0;
  return (
    <div className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-800">
      <div>
        <Label>{t("repeat")}</Label>
        <Select
          value={repeat}
          onChange={(event) => setRepeat(event.target.value as typeof repeat)}
          aria-label={t("repeat")}
        >
          {(["daily", "weekly", "monthly", "yearly"] as const).map((value) => (
            <option key={value} value={value}>
              {t(`repeats.${value}`)}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label>{t("interval")}</Label>
        <Input
          inputMode="numeric"
          value={interval}
          onChange={(event) => setRepeatInterval(event.target.value)}
          aria-label={t("interval")}
        />
      </div>
      {repeat === "weekly" ? (
        <fieldset className="flex flex-wrap gap-3 sm:col-span-2">
          <legend className="mb-1 text-sm font-medium">{t("weekdays")}</legend>
          {[1, 2, 3, 4, 5, 6, 0].map((day) => (
            <label key={day} className="flex items-center gap-1 text-sm">
              <input
                type="checkbox"
                checked={weekdays.includes(day)}
                onChange={(event) =>
                  setWeekdays((current) =>
                    event.target.checked
                      ? [...current, day]
                      : current.filter((value) => value !== day),
                  )
                }
              />
              {t(`weekday.${day}`)}
            </label>
          ))}
        </fieldset>
      ) : null}
      {repeat === "monthly" ? (
        <div className="sm:col-span-2">
          <Label>{t("monthlyBy")}</Label>
          <Select
            value={monthlyBy}
            onChange={(event) => setMonthlyBy(event.target.value as "day" | "weekday")}
            aria-label={t("monthlyBy")}
          >
            <option value="day">{t("monthlyByDay")}</option>
            <option value="weekday">{t("monthlyByWeekday")}</option>
          </Select>
        </div>
      ) : null}
      <div>
        <Label>{t("windowStarts")}</Label>
        <Input
          type="time"
          value={windowStarts}
          onChange={(event) => setWindowStarts(event.target.value)}
          aria-label={t("windowStarts")}
        />
      </div>
      <div>
        <Label>{t("windowEnds")}</Label>
        <Input
          type="time"
          value={windowEnds}
          onChange={(event) => setWindowEnds(event.target.value)}
          aria-label={t("windowEnds")}
        />
      </div>
      <div>
        <Label>{t("estimatedMinutes")}</Label>
        <Input
          inputMode="numeric"
          value={minutes}
          onChange={(event) => setMinutes(event.target.value)}
          aria-label={t("estimatedMinutes")}
        />
      </div>
      <div>
        <Label>{t("priority")}</Label>
        <Select
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
          aria-label={t("priority")}
        >
          {(["urgent", "high", "normal", "low"] as const).map((value) => (
            <option key={value} value={value}>
              {t(`priorities.${value}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="sm:col-span-2">
        <Label>{t("qualifications")}</Label>
        <QualificationPicker value={skills} onChange={setSkills} />
      </div>
      <div className="sm:col-span-2">
        <Label>{t("instructions")}</Label>
        <Textarea
          rows={2}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          aria-label={t("instructions")}
        />
      </div>
      <div className="sm:col-span-2">
        <Label>{t("visitLines")}</Label>
        <LinesEditor lines={lines} onChange={setLines} />
      </div>
      {withEffectiveDate ? (
        <div>
          <Label>{t("effectiveFrom")}</Label>
          <DateField
            value={effectiveFrom}
            onChange={setEffectiveFrom}
            aria-label={t("effectiveFrom")}
          />
        </div>
      ) : null}
      <div className={withEffectiveDate ? "" : "sm:col-span-2"}>
        <Label>{t("reason")}</Label>
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          aria-label={t("reason")}
          placeholder={t("reasonPlaceholder")}
        />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button
          size="sm"
          disabled={busy || !valid}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit({
                recurrence: {
                  repeat,
                  interval: Number(interval.trim()),
                  ...(repeat === "weekly" && weekdays.length ? { weekdays } : {}),
                  ...(repeat === "monthly" ? { monthlyBy } : {}),
                },
                windowStarts,
                windowEnds,
                estimatedMinutes: Number(minutes.trim()),
                priority,
                requiredQualificationTypeIds: skills,
                instructions: instructions.trim() || null,
                lines: lineInputs(lines),
                effectiveFrom,
                reason: reason.trim(),
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {submitLabel ?? t("saveVersion")}
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("discard")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
