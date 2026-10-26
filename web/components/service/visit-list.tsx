"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input, Label, Select, Textarea } from "@openbooks/ui";
import type { VisitSummary } from "@openbooks/engine/service/reads";
import { DateField } from "../date-field";
import { VisitStatusBadge, useServiceFormat } from "./format";
import { QualificationPicker } from "./pickers";

/** A record's visits in date order; each opens the visit drawer. */
export function VisitList({
  visits,
  onOpen,
}: {
  visits: readonly VisitSummary[];
  onOpen: (visitId: string) => void;
}) {
  const t = useTranslations("service.visit");
  const ts = useTranslations("service");
  const f = useServiceFormat();
  if (!visits.length) return <p className="text-sm text-slate-500">{t("none")}</p>;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {visits.map((visit) => (
        <li key={visit.id}>
          <button
            type="button"
            onClick={() => onOpen(visit.id)}
            className="flex w-full items-center justify-between gap-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-900"
          >
            <span className="min-w-0">
              <span className="font-medium text-slate-900 dark:text-slate-100">
                {t("sequence", { sequence: visit.sequence })} · {ts(`visitKind.${visit.kind}`)}
              </span>
              <span className="block truncate text-xs text-slate-500">
                {visit.technicians.length
                  ? `${visit.technicians.map((tech) => tech.name).join(", ")} · ${f.instant(visit.technicians[0]!.startsAt)}`
                  : (visit.occursOn ?? visit.preferredOn)
                    ? f.date(visit.occursOn ?? visit.preferredOn)
                    : t("unassigned")}
              </span>
            </span>
            <VisitStatusBadge status={visit.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export type VisitPlanInput = {
  estimatedMinutes: number;
  priority?: string;
  preferredOn: string | null;
  windowStartsAt: string | null;
  windowEndsAt: string | null;
  instructions: string | null;
  requiredQualificationTypeIds: string[];
};

/** A new visit's plan: length, preferred day, optional arrival window and skills. */
export function VisitPlanForm({
  defaultMinutes,
  onSubmit,
  onCancel,
}: {
  defaultMinutes: number;
  onSubmit: (visit: VisitPlanInput) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useTranslations("service.form");
  const [minutes, setMinutes] = useState(String(defaultMinutes));
  const [preferredOn, setPreferredOn] = useState<string | null>(null);
  const [windowStart, setWindowStart] = useState("");
  const [windowEnd, setWindowEnd] = useState("");
  const [priority, setPriority] = useState("");
  const [instructions, setInstructions] = useState("");
  const [skills, setSkills] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toInstant = (local: string) => (local ? new Date(local).toISOString() : null);
  return (
    <div className="mb-3 grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2 dark:border-slate-800">
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
        <Label>{t("preferredOn")}</Label>
        <DateField
          value={preferredOn ?? ""}
          onChange={(value) => setPreferredOn(value || null)}
          aria-label={t("preferredOn")}
        />
      </div>
      <div>
        <Label>{t("windowStart")}</Label>
        <Input
          type="datetime-local"
          value={windowStart}
          onChange={(event) => setWindowStart(event.target.value)}
          aria-label={t("windowStart")}
        />
      </div>
      <div>
        <Label>{t("windowEnd")}</Label>
        <Input
          type="datetime-local"
          value={windowEnd}
          onChange={(event) => setWindowEnd(event.target.value)}
          aria-label={t("windowEnd")}
        />
      </div>
      <div>
        <Label>{t("priority")}</Label>
        <Select
          value={priority}
          onChange={(event) => setPriority(event.target.value)}
          aria-label={t("priority")}
        >
          <option value="">{t("inheritPriority")}</option>
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
      <div className="flex gap-2 sm:col-span-2">
        <Button
          size="sm"
          disabled={busy || !/^\d+$/.test(minutes.trim())}
          onClick={async () => {
            setBusy(true);
            try {
              await onSubmit({
                estimatedMinutes: Number(minutes.trim()),
                ...(priority ? { priority } : {}),
                preferredOn,
                windowStartsAt: toInstant(windowStart),
                windowEndsAt: toInstant(windowEnd),
                instructions: instructions.trim() || null,
                requiredQualificationTypeIds: skills,
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("addVisit")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("discard")}
        </Button>
      </div>
    </div>
  );
}
