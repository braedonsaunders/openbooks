"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ActionAlert } from "@braedonsaunders/appkit-errors/react";
import { Badge, Button, Input, Label, Select, Textarea, UrlDrawer } from "@openbooks/ui";
import { DrawerTabStrip } from "@/components/drawer-tab-strip";
import { PagedTable } from "@/components/paged-table";
import { useMoney } from "@/components/money-provider";
import { useAppAction } from "@/lib/use-app-action";
import { useDirtyClose } from "@/lib/use-dirty-close";
import { mergeHref } from "@/lib/list-params";
import { postJson } from "../depth-client";
import type { MaintenanceData, ScheduleDetail } from "./_data";
import { ScheduleFields, scheduleBody, type ScheduleFormValues } from "./ScheduleFields";
import { DateField } from "@/components/date-field";

type Tab = "record" | "history" | "schedule" | "meter";

/**
 * One maintenance schedule: record work against it (linked to the bill
 * line that paid for it; a betterment is proposed for capitalization), the
 * asset's maintenance history, the schedule's terms and meter readings.
 */
export function ScheduleDrawer({
  schedule,
  data,
  closeHref,
  createMode = false,
}: {
  schedule: ScheduleDetail | null;
  data: MaintenanceData;
  closeHref: string;
  createMode?: boolean;
}) {
  if (createMode) return <ScheduleCreateDrawer data={data} closeHref={closeHref} />;
  return schedule ? (
    <ScheduleRecordDrawer schedule={schedule} data={data} closeHref={closeHref} />
  ) : null;
}

function ScheduleCreateDrawer({ data, closeHref }: { data: MaintenanceData; closeHref: string }) {
  const t = useTranslations("assets");
  const tc = useTranslations("common");
  const router = useRouter();
  const action = useAppAction();
  const [form, setForm] = useState(() => ({
    assetId: data.assets[0]?.id ?? "",
    values: {
      name: "",
      intervalMonths: "12",
      intervalUsage: "",
      usageUnit: "",
      startsOn: data.today,
      leadDays: "14",
      vendorPartyId: "",
      estimatedCost: "",
    } satisfies ScheduleFormValues,
  }));
  const [initialForm] = useState(form);
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  const closeGuard = useDirtyClose({
    dirty,
    busy: action.busy,
    onClose: () => {},
    message: tc("feedback.unsavedChanges"),
    confirmLabel: tc("confirm.discardChanges"),
  });

  async function create() {
    await action.execute(
      () =>
        postJson<{ id: string }>(
          "/api/assets/maintenance/schedules",
          { assetId: form.assetId, ...scheduleBody(form.values) },
          t("maintenance.saveFailed"),
        ),
      {
        fallbackMessage: t("maintenance.saveFailed"),
        successMessage: t("maintenance.created"),
        onOk: (created) => {
          router.push(
            mergeHref("/assets/maintenance", data.currentParams, { schedule: created.id }),
          );
          router.refresh();
        },
      },
    );
  }

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      beforeClose={closeGuard.beforeClose}
      size="xl"
      title={t("maintenance.new")}
      headerActions={
        <Button
          disabled={action.busy || !form.assetId || !form.values.name.trim()}
          onClick={() => void create()}
        >
          {t("maintenance.create")}
        </Button>
      }
    >
      <div className="space-y-4 p-1">
        <ActionAlert error={action.refusal} fallbackMessage={t("maintenance.saveFailed")} />
        <div className="space-y-1.5">
          <Label htmlFor="new-schedule-asset">{t("maintenance.fields.asset")}</Label>
          <Select
            id="new-schedule-asset"
            value={form.assetId}
            onChange={(event) =>
              setForm((current) => ({ ...current, assetId: event.target.value }))
            }
          >
            {data.assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.label}
              </option>
            ))}
          </Select>
        </div>
        <ScheduleFields
          idPrefix="new-schedule"
          values={form.values}
          vendors={data.vendors}
          onChange={(patch) =>
            setForm((current) => ({ ...current, values: { ...current.values, ...patch } }))
          }
        />
      </div>
    </UrlDrawer>
  );
}

function ScheduleRecordDrawer({
  schedule,
  data,
  closeHref,
}: {
  schedule: ScheduleDetail;
  data: MaintenanceData;
  closeHref: string;
}) {
  const t = useTranslations("assets");
  const { money } = useMoney();
  const router = useRouter();
  const action = useAppAction();
  const manage = data.canMaintain;
  const tabs: Tab[] = manage ? ["record", "history", "schedule", "meter"] : ["history"];
  const [tab, setTab] = useState<Tab>(tabs[0]!);
  const [performedOn, setPerformedOn] = useState(data.today);
  const [description, setDescription] = useState(schedule.name);
  const [cost, setCost] = useState("");
  const [usage, setUsage] = useState("");
  const [vendorPartyId, setVendorPartyId] = useState(schedule.vendorPartyId ?? "");
  const [treatment, setTreatment] = useState<"expense" | "betterment">("expense");
  const [sourceLine, setSourceLine] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [readOn, setReadOn] = useState(data.today);
  const [reading, setReading] = useState("");
  const [unit, setUnit] = useState(schedule.usageUnit ?? "");
  const [isActive, setIsActive] = useState(schedule.isActive);
  const [values, setValues] = useState<ScheduleFormValues>({
    name: schedule.name,
    intervalMonths: schedule.intervalMonths === null ? "" : String(schedule.intervalMonths),
    intervalUsage: schedule.intervalUsage ?? "",
    usageUnit: schedule.usageUnit ?? "",
    startsOn: schedule.startsOn,
    leadDays: String(schedule.leadDays),
    vendorPartyId: schedule.vendorPartyId ?? "",
    estimatedCost: schedule.estimatedCost ?? "",
  });
  const lines = data.billLines.filter(
    (line) => line.subsidiaryId === null || line.subsidiaryId === schedule.subsidiaryId,
  );

  const run = (url: string, body: unknown, success: string, method: "POST" | "PATCH" = "POST") =>
    action.execute(() => postJson(url, body, t("maintenance.saveFailed"), method), {
      fallbackMessage: t("maintenance.saveFailed"),
      successMessage: success,
      onOk: () => router.refresh(),
    });

  const field = (id: string, label: string, control: ReactNode) => (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {control}
    </div>
  );

  return (
    <UrlDrawer
      open
      closeHref={closeHref}
      size="xl"
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono text-sm text-slate-500 dark:text-slate-400">
            {schedule.assetNumber}
          </span>
          <span>{schedule.name}</span>
          {schedule.isActive ? null : (
            <Badge variant="secondary">{t("maintenance.inactive")}</Badge>
          )}
        </span>
      }
      description={t("maintenance.drawerDescription", {
        asset: schedule.assetName,
        due:
          [
            schedule.nextDueOn,
            schedule.nextDueUsage && schedule.usageUnit
              ? `${schedule.nextDueUsage} ${schedule.usageUnit}`
              : null,
          ]
            .filter(Boolean)
            .join(" / ") || "—",
      })}
      subtabs={
        <DrawerTabStrip
          ariaLabel={t("maintenance.tabsAria")}
          activeKey={tab}
          onSelect={setTab}
          tabs={tabs.map((key) => ({ key, label: t(`maintenance.drawerTabs.${key}`) }))}
        />
      }
    >
      <div className="space-y-4 p-1">
        <ActionAlert error={action.refusal} fallbackMessage={t("maintenance.saveFailed")} />
        {tab === "record" ? (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {field(
                "rec-date",
                t("maintenance.fields.performedOn"),
                <DateField
                  id="rec-date"
                  value={performedOn}
                  onChange={(value) => setPerformedOn(value)}
                />,
              )}
              {field(
                "rec-cost",
                t("maintenance.fields.cost"),
                <Input
                  id="rec-cost"
                  inputMode="decimal"
                  value={cost}
                  onChange={(event) => setCost(event.target.value)}
                />,
              )}
              {schedule.usageUnit
                ? field(
                    "rec-usage",
                    t("maintenance.fields.meterAtService", { unit: schedule.usageUnit }),
                    <Input
                      id="rec-usage"
                      inputMode="decimal"
                      value={usage}
                      onChange={(event) => setUsage(event.target.value)}
                    />,
                  )
                : null}
              {field(
                "rec-vendor",
                t("maintenance.fields.vendor"),
                <Select
                  id="rec-vendor"
                  value={vendorPartyId}
                  onChange={(event) => setVendorPartyId(event.target.value)}
                >
                  <option value="">{t("maintenance.fields.none")}</option>
                  {data.vendors.map((vendor) => (
                    <option key={vendor.id} value={vendor.id}>
                      {vendor.name}
                    </option>
                  ))}
                </Select>,
              )}
              {field(
                "rec-treatment",
                t("maintenance.fields.treatment"),
                <Select
                  id="rec-treatment"
                  value={treatment}
                  onChange={(event) => setTreatment(event.target.value as "expense" | "betterment")}
                >
                  <option value="expense">{t("maintenance.treatment.expense")}</option>
                  {data.proposalsEnabled ? (
                    <option value="betterment">{t("maintenance.treatment.betterment")}</option>
                  ) : null}
                </Select>,
              )}
              {field(
                "rec-line",
                t("maintenance.fields.billLine"),
                <Select
                  id="rec-line"
                  value={sourceLine}
                  onChange={(event) => setSourceLine(event.target.value)}
                >
                  <option value="">{t("maintenance.fields.none")}</option>
                  {lines.map((line) => (
                    <option key={line.id} value={line.id}>
                      {line.label}
                    </option>
                  ))}
                </Select>,
              )}
            </div>
            {treatment === "betterment" ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {t("maintenance.bettermentHelp")}
              </p>
            ) : null}
            {field(
              "rec-description",
              t("maintenance.fields.description"),
              <Textarea
                id="rec-description"
                rows={2}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />,
            )}
            <Button
              disabled={
                action.busy || !description.trim() || (treatment === "betterment" && !sourceLine)
              }
              onClick={() =>
                run(
                  "/api/assets/maintenance/records",
                  {
                    action: "record",
                    assetId: schedule.assetId,
                    scheduleId: schedule.id,
                    performedOn,
                    usageReading: usage.trim() || null,
                    description,
                    vendorPartyId: vendorPartyId || null,
                    cost: cost.trim() || null,
                    treatment,
                    sourceDocumentLineId: sourceLine || null,
                  },
                  t("maintenance.recorded"),
                )
              }
            >
              {t("maintenance.record")}
            </Button>
          </div>
        ) : null}

        {tab === "history" ? (
          <div className="space-y-3">
            <PagedTable
              rows={schedule.records}
              source="asset_maintenance_records"
              rowKey={(row) => row.id}
              columns={[
                {
                  key: "date",
                  header: t("maintenance.columns.performedOn"),
                  cell: (row) => row.performedOn,
                },
                {
                  key: "description",
                  header: t("maintenance.fields.description"),
                  cell: (row) => (
                    <span
                      className={
                        row.status === "cancelled" ? "text-slate-400 line-through" : undefined
                      }
                    >
                      {row.description}
                    </span>
                  ),
                },
                {
                  key: "vendor",
                  header: t("maintenance.fields.vendor"),
                  cell: (row) => row.vendorName ?? "—",
                },
                {
                  key: "bill",
                  header: t("maintenance.columns.bill"),
                  cell: (row) => row.sourceLabel ?? "—",
                },
                {
                  key: "treatment",
                  header: t("maintenance.fields.treatment"),
                  cell: (row) =>
                    row.proposalId ? (
                      <Link
                        href={`/assets/proposals?proposal=${row.proposalId}`}
                        className="text-teal-700 hover:underline dark:text-teal-300"
                      >
                        {t(`maintenance.treatment.${row.treatment}`)}
                      </Link>
                    ) : (
                      t(`maintenance.treatment.${row.treatment}`)
                    ),
                },
                {
                  key: "cost",
                  header: t("maintenance.fields.cost"),
                  align: "right",
                  cell: (row) => <span className="tabular-nums">{money(row.cost)}</span>,
                },
                {
                  key: "actions",
                  header: "",
                  cell: (row) =>
                    manage && row.status === "recorded" ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={action.busy || !cancelReason.trim()}
                        onClick={() =>
                          run(
                            "/api/assets/maintenance/records",
                            { action: "cancel", recordId: row.id, reason: cancelReason },
                            t("maintenance.cancelled"),
                          )
                        }
                      >
                        {t("maintenance.cancel")}
                      </Button>
                    ) : row.status === "cancelled" ? (
                      <Badge variant="secondary">{t("maintenance.cancelledBadge")}</Badge>
                    ) : null,
                },
              ]}
              empty={
                <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                  {t("maintenance.noRecords")}
                </p>
              }
              emptyAsRow
            />
            {manage && schedule.records.some((row) => row.status === "recorded")
              ? field(
                  "cancel-reason",
                  t("maintenance.fields.cancelReason"),
                  <Input
                    id="cancel-reason"
                    value={cancelReason}
                    onChange={(event) => setCancelReason(event.target.value)}
                  />,
                )
              : null}
          </div>
        ) : null}

        {tab === "schedule" ? (
          <div className="space-y-3">
            <ScheduleFields
              idPrefix="edit-schedule"
              values={values}
              vendors={data.vendors}
              onChange={(patch) => setValues((current) => ({ ...current, ...patch }))}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(event) => setIsActive(event.target.checked)}
              />
              {t("maintenance.fields.active")}
            </label>
            <Button
              disabled={action.busy || !values.name.trim()}
              onClick={() =>
                run(
                  `/api/assets/maintenance/schedules/${schedule.id}`,
                  { ...scheduleBody(values), isActive },
                  t("maintenance.saved"),
                  "PATCH",
                )
              }
            >
              {t("maintenance.save")}
            </Button>
          </div>
        ) : null}

        {tab === "meter" ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {schedule.currentUsage
                ? t("maintenance.currentReading", {
                    reading: schedule.currentUsage,
                    unit: schedule.usageUnit ?? "",
                  })
                : t("maintenance.noReading")}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              {field(
                "meter-date",
                t("maintenance.fields.readOn"),
                <DateField id="meter-date" value={readOn} onChange={(value) => setReadOn(value)} />,
              )}
              {field(
                "meter-reading",
                t("maintenance.fields.reading"),
                <Input
                  id="meter-reading"
                  inputMode="decimal"
                  value={reading}
                  onChange={(event) => setReading(event.target.value)}
                />,
              )}
              {field(
                "meter-unit",
                t("maintenance.fields.usageUnit"),
                <Input
                  id="meter-unit"
                  value={unit}
                  onChange={(event) => setUnit(event.target.value)}
                />,
              )}
            </div>
            <Button
              disabled={action.busy || !reading.trim() || !unit.trim()}
              onClick={() =>
                run(
                  `/api/assets/${schedule.assetId}/meter-readings`,
                  { readOn, reading, unit },
                  t("maintenance.readingRecorded"),
                )
              }
            >
              {t("maintenance.recordReading")}
            </Button>
          </div>
        ) : null}
      </div>
    </UrlDrawer>
  );
}
