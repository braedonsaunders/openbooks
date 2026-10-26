"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Badge, Button, Select } from "@openbooks/ui";
import { PagedTable } from "@/components/paged-table";
import { decimalLabel, viewerDate } from "@/lib/format";
import type { PendingWeekEntry, TimesheetPickers } from "../../api/timesheets/_lib";
import type { AdditionalTimeSelection } from "@openbooks/engine/projects/additional-time-submission";

export function AdditionalTimeReview({
  entries,
  pickers,
  busy,
  refusal,
  onBack,
  onSubmit,
  canSubmit = true,
  onCorrect,
}: {
  entries: PendingWeekEntry[];
  pickers: TimesheetPickers;
  busy: boolean;
  refusal: { message: string; remedy: string | null } | null;
  onBack: () => void;
  onSubmit: (selections: AdditionalTimeSelection[], reason: string) => Promise<void>;
  canSubmit?: boolean;
  onCorrect?: (
    entry: PendingWeekEntry,
    typeId: string,
    typeUpdatedAt: string,
    commandId: string,
    reason: string,
  ) => Promise<boolean>;
}) {
  const t = useTranslations("timesheets.additional");
  const common = useTranslations("common");
  const timesheets = useTranslations("timesheets");
  const locale = useLocale();
  const statusLabel = (status: string) =>
    common.has(`status.${status}` as never)
      ? common(`status.${status}` as never)
      : status === "submitted"
        ? timesheets("status.submitted")
        : status;
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [reason, setReason] = useState("");
  const correctionCopy = useTranslations("timesheets.timeTypeCorrection");
  const classificationLabel = (classification: string | undefined) => {
    switch (classification) {
      case "regular":
        return correctionCopy("classRegular");
      case "overtime":
        return correctionCopy("classOvertime");
      case "double_time":
        return correctionCopy("classDoubleTime");
      case "other":
        return correctionCopy("classOther");
      default:
        return correctionCopy("classUnknown");
    }
  };
  const [correcting, setCorrecting] = useState<{
    entry: PendingWeekEntry;
    commandId: string;
  } | null>(null);
  const [typeId, setTypeId] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const chosen = entries.filter((entry) => selected.get(entry.id) === entry.updatedAt);
  const projectName = (id: string | null) =>
    pickers.projects.find((project) => project.value === id)?.label ?? "—";
  const itemName = (id: string | null) =>
    pickers.items.find((item) => item.value === id)?.label ?? "—";
  const alert = refusal ? (
    <div
      role="alert"
      className="rounded-md border border-destructive/30 p-3 text-sm text-destructive"
    >
      <p>{refusal.message}</p>
      {refusal.remedy ? <p className="mt-1">{refusal.remedy}</p> : null}
    </div>
  ) : null;
  if (correcting) {
    const entry = correcting.entry;
    const type = pickers.timeTypes.find((option) => option.value === typeId);
    const currentType = pickers.timeTypes.find((option) => option.value === entry.timeTypeId);
    const changed = entries.find((row) => row.id === entry.id)?.updatedAt !== entry.updatedAt;
    return (
      <div className="space-y-4 p-6">
        <h2 className="font-medium">{correctionCopy("title")}</h2>
        <p>
          {viewerDate(entry.workedOn, locale, "UTC")} · {entry.hours} {t("hours")} ·{" "}
          {entry.fieldTicketNumber ?? t("directTime")}
        </p>
        <p className="text-sm text-muted-foreground">{correctionCopy("description")}</p>
        <label className="block space-y-1 text-sm">
          <span>{correctionCopy("current")}</span>
          <p>{currentType?.label ?? "—"}</p>
          <p className="text-muted-foreground">
            {correctionCopy("classification", {
              value: classificationLabel(currentType?.classification),
            })}
          </p>
        </label>
        <label className="block space-y-1 text-sm">
          <span>{correctionCopy("replacement")}</span>
          <Select
            value={typeId}
            disabled={busy || changed}
            onChange={(event) => setTypeId(event.target.value)}
          >
            <option value="">{correctionCopy("choose")}</option>
            {pickers.timeTypes
              .filter(
                (option) =>
                  option.updatedAt &&
                  option.billMultiplier != null &&
                  option.excludeFromWages === false,
              )
              .map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label} · {classificationLabel(option.classification)}
                </option>
              ))}
          </Select>
        </label>
        {type ? (
          <div className="space-y-1 text-sm">
            <p>
              {correctionCopy("classification", {
                value: classificationLabel(type.classification),
              })}
            </p>
            <p>
              {correctionCopy("multipliers", {
                cost: type.costMultiplier,
                bill: type.billMultiplier ?? "—",
              })}
            </p>
          </div>
        ) : null}
        <label className="block space-y-1 text-sm">
          <span>{correctionCopy("reason")}</span>
          <textarea
            className="w-full rounded-md border bg-background p-2"
            rows={3}
            maxLength={500}
            value={correctionReason}
            disabled={busy}
            onChange={(event) => setCorrectionReason(event.target.value)}
          />
        </label>
        {changed ? <p role="alert">{correctionCopy("changed")}</p> : null}
        {alert}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={() => setCorrecting(null)}>
            {correctionCopy("back")}
          </Button>
          <Button
            disabled={
              busy ||
              changed ||
              !type?.updatedAt ||
              typeId === entry.timeTypeId ||
              correctionReason.trim().length < 10
            }
            onClick={async () => {
              if (!onCorrect || !type?.updatedAt) return;
              if (
                await onCorrect(
                  entry,
                  typeId,
                  type.updatedAt,
                  correcting.commandId,
                  correctionReason.trim(),
                )
              )
                setCorrecting(null);
            }}
          >
            {correctionCopy("save")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4 p-6">
      <p className="text-sm text-muted-foreground">
        {canSubmit ? t("description") : correctionCopy("reviewDescription")}
      </p>
      <PagedTable
        rows={entries}
        rowKey={(entry) => entry.id}
        searchable
        searchLayout="drawer"
        emptyAsRow
        empty={t("empty")}
        selection={
          canSubmit
            ? {
                getId: (entry) => entry.id,
                selectedIds: new Set(chosen.map((entry) => entry.id)),
                disabled: busy,
                onToggle: (id) =>
                  setSelected((previous) => {
                    const entry = entries.find((row) => row.id === id);
                    const next = new Map(previous);
                    if (!entry) return next;
                    if (next.get(id) === entry.updatedAt) next.delete(id);
                    else next.set(id, entry.updatedAt);
                    return next;
                  }),
                onToggleAll: (ids) =>
                  setSelected((previous) => {
                    const next = new Map(previous);
                    const matching = entries.filter((entry) => ids.includes(entry.id));
                    const all = matching.every((entry) => next.get(entry.id) === entry.updatedAt);
                    for (const entry of matching) {
                      if (all) next.delete(entry.id);
                      else next.set(entry.id, entry.updatedAt);
                    }
                    return next;
                  }),
              }
            : undefined
        }
        columns={[
          {
            key: "date",
            header: t("date"),
            cell: (entry) => viewerDate(entry.workedOn, locale, "UTC"),
            search: (entry) => entry.workedOn,
          },
          {
            key: "project",
            header: t("project"),
            cell: (entry) => projectName(entry.projectId),
            search: (entry) => projectName(entry.projectId),
          },
          {
            key: "source",
            header: t("source"),
            cell: (entry) => (
              <div className="flex flex-wrap items-center gap-2">
                <span>{entry.fieldTicketNumber ?? t("directTime")}</span>
                {entry.fieldTicketStatus ? (
                  <Badge variant="secondary">{statusLabel(entry.fieldTicketStatus)}</Badge>
                ) : null}
              </div>
            ),
            search: (entry) =>
              [
                entry.fieldTicketNumber ?? t("directTime"),
                entry.fieldTicketStatus ? statusLabel(entry.fieldTicketStatus) : "",
              ].join(" "),
          },
          {
            key: "item",
            header: t("item"),
            cell: (entry) => itemName(entry.itemId),
            search: (entry) => itemName(entry.itemId),
          },
          {
            key: "hours",
            header: t("hours"),
            align: "right",
            cell: (entry) => decimalLabel(Number(entry.hours), locale, 0, 4),
          },
          {
            key: "status",
            header: t("timeStatus"),
            cell: (entry) => <Badge variant="outline">{statusLabel(entry.status)}</Badge>,
          },
          {
            key: "timeType",
            header: correctionCopy("current"),
            cell: (entry) =>
              pickers.timeTypes.find((type) => type.value === entry.timeTypeId)?.label ?? "—",
          },
          ...(onCorrect
            ? [
                {
                  key: "correct",
                  header: correctionCopy("title"),
                  cell: (entry: PendingWeekEntry) =>
                    !entry.workOrderId &&
                    (!entry.fieldTicketId ||
                      ["approved", "posted"].includes(entry.fieldTicketStatus ?? "")) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setCorrecting({ entry, commandId: crypto.randomUUID() });
                          setTypeId("");
                          setCorrectionReason("");
                        }}
                      >
                        {correctionCopy("action")}
                      </Button>
                    ) : null,
                },
              ]
            : []),
        ]}
      />
      {canSubmit ? (
        <label className="block space-y-1 text-sm">
          <span>{t("reason")}</span>
          <textarea
            className="w-full rounded-md border bg-background p-2"
            rows={3}
            maxLength={500}
            value={reason}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
      ) : null}
      {alert}
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={onBack}>
          {t("back")}
        </Button>
        {canSubmit ? (
          <Button
            disabled={
              busy || chosen.length === 0 || chosen.length > 250 || reason.trim().length < 10
            }
            onClick={() =>
              void onSubmit(
                chosen.map(({ id, updatedAt }) => ({ id, updatedAt })),
                reason.trim(),
              )
            }
          >
            {busy ? t("submitting") : t("submit", { count: chosen.length })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
