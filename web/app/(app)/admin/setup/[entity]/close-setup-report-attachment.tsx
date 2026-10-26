"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Label, SearchSelect, Select, cn } from "@openbooks/ui";
import { ChevronRight, X } from "lucide-react";
import type { ReportDescriptor } from "../../../../../lib/close/report-descriptor";
import type { Opt } from "../../../../../lib/documents.ts";
import { BREAKOUT_DIMENSIONS, Field, periodOptions } from "./close-setup-shared";
import type { Props, ReportAttachment, ReportDefEntry } from "./close-setup-types";
import { DateField } from "../../../../../components/date-field";

/** Read-only recap of the parameters a report already carries in its own
 * definition, shown above the editable overrides. */
export function ReportDescriptorSummary({ descriptor }: { descriptor: ReportDescriptor }) {
  const t = useTranslations("close.setup");
  const parts: Array<[string, string[]]> = [
    [t("reportParams.definedDate"), descriptor.dateRange ? [descriptor.dateRange] : []],
    [t("reportParams.definedBreakouts"), descriptor.breakouts],
    [t("reportParams.definedFilters"), descriptor.filters],
    [t("reportParams.definedMeasures"), descriptor.measures],
  ];
  const shown = parts.filter(([, values]) => values.length > 0);
  if (shown.length === 0)
    return <p className="text-xs text-slate-400">{t("reportParams.noDefined")}</p>;
  return (
    <div className="space-y-1 rounded-md bg-slate-50 p-2 text-xs dark:bg-slate-900/50">
      {shown.map(([label, values]) => (
        <div key={label} className="flex flex-wrap gap-x-1.5">
          <span className="font-medium text-slate-500 dark:text-slate-400">{label}:</span>
          <span className="text-slate-600 dark:text-slate-300">{values.join(" · ")}</span>
        </div>
      ))}
    </div>
  );
}

/** One attached report: its defined parameters (read-only) plus the author's
 * editable date-range / break-out / dimension-filter overrides for delivery. */
export function ReportAttachmentCard({
  attachment,
  meta,
  props,
  onChange,
  onRemove,
}: {
  attachment: ReportAttachment;
  meta?: ReportDefEntry;
  props: Props;
  onChange: (patch: Partial<ReportAttachment>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("close.setup");
  const tPeriods = useTranslations("periodLabels");
  const [open, setOpen] = useState(false);
  const name =
    meta?.name ??
    (t.has(`reports.${attachment.slug}`) ? t(`reports.${attachment.slug}`) : attachment.slug);
  const descriptor = meta?.descriptor ?? {
    dateRange: null,
    breakouts: [],
    filters: [],
    measures: [],
  };
  const period = attachment.period ?? "$close";
  const dimSelect = (label: string, key: keyof ReportAttachment, options: Opt[]) => (
    <Field label={label}>
      <SearchSelect
        value={String(attachment[key] ?? "")}
        onChange={(value) => onChange({ [key]: value || undefined } as Partial<ReportAttachment>)}
        options={options.map((option) => ({
          value: option.id,
          label: option.name ?? option.id,
        }))}
        clearable
        searchable
        ariaLabel={label}
        placeholder={t("reportParams.anyValue")}
      />
    </Field>
  );
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between gap-2 p-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            size={14}
            className={cn("shrink-0 text-slate-400 transition-transform", open && "rotate-90")}
          />
          <span className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
            {name}
          </span>
          {meta?.kind === "custom" ? (
            <Badge variant="outline">{t("reportGroups.custom")}</Badge>
          ) : null}
        </button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t("actions.removeValue", { value: name })}
          onClick={onRemove}
        >
          <X size={14} />
        </Button>
      </div>
      {open ? (
        <div className="space-y-3 border-t border-slate-200 p-3 dark:border-slate-800">
          <ReportDescriptorSummary descriptor={descriptor} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("reportParams.dateRange")}>
              <SearchSelect
                value={period}
                onChange={(value) => onChange({ period: value })}
                options={periodOptions(
                  t("reportParams.closePeriod"),
                  t("reportParams.custom"),
                  (id) => tPeriods(`presets.${id}` as never),
                  (group) => tPeriods(`groups.${group}` as never),
                )}
                searchable
                ariaLabel={t("reportParams.dateRange")}
              />
            </Field>
            <Field label={t("reportParams.breakout")}>
              <Select
                value={attachment.breakout ?? "none"}
                onChange={(event) => onChange({ breakout: event.target.value })}
              >
                {BREAKOUT_DIMENSIONS.map((value) => (
                  <option key={value} value={value}>
                    {t(`reportParams.breakouts.${value}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {period === "custom" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("reportParams.from")}>
                <DateField
                  value={attachment.from ?? ""}
                  onChange={(value) => onChange({ from: value })}
                />
              </Field>
              <Field label={t("reportParams.to")}>
                <DateField
                  value={attachment.to ?? ""}
                  onChange={(value) => onChange({ to: value })}
                />
              </Field>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label className="text-xs uppercase tracking-wide text-slate-400">
              {t("reportParams.filters")}
            </Label>
            <div className="grid gap-3 sm:grid-cols-2">
              {dimSelect(
                t("reportParams.department"),
                "departmentId",
                props.dimensions.departments,
              )}
              {dimSelect(t("reportParams.location"), "locationId", props.dimensions.locations)}
              {dimSelect(t("reportParams.class"), "classId", props.dimensions.classes)}
              {dimSelect(t("reportParams.project"), "projectId", props.dimensions.projects)}
              {props.subsidiaries.length > 0
                ? dimSelect(t("reportParams.subsidiary"), "subsidiaryId", props.subsidiaries)
                : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
