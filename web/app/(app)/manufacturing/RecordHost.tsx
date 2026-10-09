"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { Button, Badge, EmptyState } from "@openbooks/ui";
import { AsyncUrlDrawer } from "@/components/async-url-drawer";
import { PagedTable } from "@/components/paged-table";
import { RecordTabs } from "@/components/module-home/record-tabs";
import { useMoney } from "@/components/money-provider";
import { formatDecimal } from "@/lib/money-format";
import { dateLabel, dateTime } from "@/lib/format";
import { confirmDialog } from "@/lib/confirm";
import { readApiErrorMessage } from "@/lib/api-error";
import type {
  ManufacturingOptions,
  ManufacturingRecordData,
  ManufacturingRow,
  ManufacturingView,
} from "@openbooks/engine/src/manufacturing/workspace.ts";
import {
  childCommands,
  headerCommand,
  recordCommands,
  type Command,
} from "./commands";
import { CommandForm } from "./CommandForm";

const tabKeys: Record<ManufacturingView, string[]> = {
  "work-orders": [
    "summary",
    "operations",
    "materials",
    "issues",
    "receipts",
    "scrap",
    "entries",
    "children",
  ],
  "work-centers": ["summary", "rates"],
  routings: ["summary", "operations", "versions"],
  mrp: ["summary", "suggestions", "capacity"],
};
const columns: Record<string, string[]> = {
  operations: [
    "sequence",
    "name",
    "centerName",
    "status",
    "quantityPlanned",
    "quantityDone",
    "quantityScrappedHere",
    "measuredQty",
    "startedAt",
    "completedAt",
  ],
  materials: [
    "itemName",
    "requiredQty",
    "issuedQty",
    "backflushQty",
    "shortageQty",
    "tracking",
    "operationSeq",
    "waiveReason",
  ],
  issues: [
    "itemName",
    "quantity",
    "unit",
    "location",
    "lotNumber",
    "serialNumber",
    "status",
    "createdAt",
  ],
  receipts: [
    "itemName",
    "quantity",
    "unit",
    "location",
    "lotNumber",
    "serialNumber",
    "status",
    "createdAt",
  ],
  scrap: [
    "quantity",
    "reasonName",
    "classification",
    "treatment",
    "frozenValue",
    "createdAt",
  ],
  entries: ["number", "date", "status", "memo"],
  children: ["number", "status", "quantity", "unit"],
  rates: ["machineRatePerHour", "effectiveFrom", "effectiveTo"],
  versions: ["code", "version", "status", "effectiveFrom", "effectiveTo"],
  suggestions: [
    "itemCode",
    "action",
    "quantity",
    "dueDate",
    "plannedStart",
    "status",
    "isExpedite",
    "dismissReason",
  ],
  capacity: [
    "workCenterCode",
    "weekStart",
    "plannedHours",
    "availableHours",
    "loadPercent",
    "overloaded",
  ],
};
const summaryKeys: Record<ManufacturingView, string[]> = {
  "work-orders": [
    "itemName",
    "subsidiaryId",
    "status",
    "priority",
    "quantityOrdered",
    "quantityCompleted",
    "quantityScrapped",
    "unit",
    "plannedStart",
    "plannedEnd",
    "bomRevision",
    "routingVersion",
    "standardCostSnapshot",
    "costCollected",
    "holdReason",
    "cancelReason",
    "releasedAt",
    "startedAt",
    "completedAt",
  ],
  "work-centers": [
    "code",
    "name",
    "kind",
    "subsidiaryId",
    "capacityHoursPerDay",
    "efficiencyPct",
    "departmentId",
    "calendarId",
    "absorbsOverhead",
    "isActive",
  ],
  routings: [
    "code",
    "name",
    "producedItemId",
    "version",
    "status",
    "effectiveFrom",
    "effectiveTo",
    "defaultIssueLocationId",
    "defaultReceiptLocationId",
    "overheadBasis",
  ],
  mrp: ["number", "status", "horizonStart", "horizonEnd", "ranAt"],
};
export function ManufacturingRecordHost({
  view,
  recordId,
  closeHref,
  options,
  canManage,
  canPost,
  canBuy,
  canReadJournal,
}: {
  view: ManufacturingView;
  recordId?: string;
  closeHref: string;
  options: ManufacturingOptions;
  canManage: boolean;
  canPost: boolean;
  canBuy: boolean;
  canReadJournal: boolean;
}) {
  const t = useTranslations("manufacturing"),
    router = useRouter(),
    locale = useLocale(),
    { money } = useMoney();
  const [data, setData] = useState<ManufacturingRecordData | null>(null),
    [loadedId, setLoadedId] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [attempt, setAttempt] = useState(0),
    [pending, setPending] = useState(false);
  const [tab, setTab] = useState("summary"),
    [selected, setSelected] = useState<ManufacturingRow | null>(null),
    [command, setCommand] = useState<Command | null>(null),
    [dirty, setDirty] = useState(false);
  const identity = useRef(recordId);
  useEffect(() => {
    setCommand(null);
    setSelected(null);
    setTab("summary");
    setDirty(false);
    setError(null);
    identity.current = recordId;
  }, [recordId]);
  useEffect(() => {
    if (!recordId || recordId === "new") {
      setData(null);
      setLoadedId(recordId ?? null);
      return;
    }
    const controller = new AbortController();
    setPending(true);
    setError(null);
    fetch("/api/manufacturing/workspace/" + view + "/" + recordId, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error(await readApiErrorMessage(response, t("loadFailed")));
        return response.json();
      })
      .then((result) => {
        setData(result);
        setLoadedId(recordId);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : t("loadFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setPending(false);
      });
    return () => controller.abort();
  }, [recordId, view, attempt, t]);
  if (!recordId) return null;
  const isNew = recordId === "new",
    visibleData = loadedId === recordId ? data : null;
  const title = isNew
    ? t("new." + view)
    : String(
        visibleData?.record.number ??
          visibleData?.record.name ??
          t("titles." + view),
      );
  const label = (value: unknown) =>
    value === null || value === undefined || value === ""
      ? "—"
      : typeof value === "boolean"
        ? t(value ? "yes" : "no")
        : t.has("values." + String(value))
          ? t("values." + String(value))
          : String(value);
  const formatted = (key: string, value: unknown) => {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
      return dateLabel(new Date(value + "T00:00:00Z"), locale);
    if (key.endsWith("At") && typeof value === "string")
      return dateTime(value, locale);
    if (["standardCostSnapshot", "costCollected", "frozenValue"].includes(key))
      return money(String(value), {
        currency:
          typeof visibleData?.record.currency === "string"
            ? visibleData.record.currency
            : undefined,
        currencyDisplay: "code",
      });
    if (
      /(?:quantity|Qty|Hours|Minutes|Percent|Pct|Rate)/i.test(key) &&
      typeof value === "string" &&
      /^\d+(?:\.\d+)?$/.test(value)
    )
      return formatDecimal(locale, value, { maximumFractionDigits: 4 });
    return label(value);
  };
  const cell = (key: string, row: ManufacturingRow) => {
    if (key === "number" && tab === "entries" && canReadJournal)
      return (
        <Link
          className="text-teal-700 hover:underline"
          href={("/journal?entry=" + row.id) as never}
        >
          {label(row[key])}
        </Link>
      );
    if (key === "number" && tab === "children")
      return (
        <Link
          className="text-teal-700 hover:underline"
          href={("/manufacturing/work-orders?record=" + row.id) as never}
        >
          {label(row[key])}
        </Link>
      );
    if (key === "code" && tab === "versions")
      return (
        <Link
          className="text-teal-700 hover:underline"
          href={("/manufacturing/routings?record=" + row.id) as never}
        >
          {label(row[key])}
        </Link>
      );
    return formatted(key, row[key]);
  };
  function openCommand(value: Command) {
    setCommand(value);
    setDirty(true);
  }
  function cancelCommand() {
    setCommand(null);
    setDirty(false);
  }
  async function saved(
    result: Record<string, unknown>,
    action: Command,
    approval: boolean,
  ) {
    toast.success(t(approval ? "approvalPending" : "saved"));
    setDirty(false);
    setCommand(null);
    setSelected(null);
    if (action.opensRecord && typeof result.id === "string") {
      const url = new URL(closeHref, window.location.origin);
      url.searchParams.set("record", result.id);
      router.replace(url.pathname + url.search);
    } else setAttempt((v) => v + 1);
    router.refresh();
  }
  const activeCommand = isNew ? headerCommand(view, options) : command;
  const rowCommands =
    selected && visibleData && canManage
      ? childCommands(
          view,
          tab,
          visibleData.record,
          selected,
          options,
          canPost,
          canBuy,
        )
      : [];
  const tabs = tabKeys[view].filter(
    (key) => key !== "entries" || canReadJournal,
  );
  const activeRows = visibleData?.sections[tab] ?? [];
  const childColumns =
    view === "routings" && tab === "operations"
      ? [
          "sequence",
          "name",
          "centerName",
          "setupMinutes",
          "runMinutesPerUnit",
          "laborMinutesPerUnit",
          "backflushAt",
          "qualityGate",
        ]
      : (columns[tab] ?? []);
  function reference(key: string, value: unknown) {
    const optionKey =
      key === "subsidiaryId"
        ? "subsidiaries"
        : key === "producedItemId"
          ? "items"
          : key === "departmentId"
            ? "departments"
            : key === "calendarId"
              ? "calendars"
              : key === "workCenterId"
                ? "centers"
                : key.endsWith("LocationId")
                  ? "locations"
                  : null;
    return optionKey
      ? (options[optionKey].find((o) => o.value === value)?.label ??
          label(value))
      : formatted(key, value);
  }
  return (
    <AsyncUrlDrawer
      open
      openKey={recordId}
      closeHref={closeHref}
      title={title}
      size="xl"
      pending={!isNew && (pending || loadedId !== recordId) && !error}
      error={error}
      onRetry={() => setAttempt((v) => v + 1)}
      beforeClose={() => !dirty || confirmDialog(t("discardDraft"))}
    >
      {isNew ? (
        <CommandForm
          key={"new-" + view}
          command={activeCommand!}
          onDirty={() => setDirty(true)}
          onSaved={saved}
          onCancel={() => router.push(closeHref)}
          onReview={(id) => {
            router.refresh();
            if (identity.current === "new") {
              const url = new URL(closeHref, window.location.origin);
              if (id) url.searchParams.set("record", id);
              else url.searchParams.delete("record");
              router.replace(url.pathname + url.search);
            }
          }}
        />
      ) : visibleData ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>
              {label(
                visibleData.record.status ??
                  (visibleData.record.isActive ? "active" : "inactive"),
              )}
            </Badge>
            {visibleData.record.pendingApproval ? (
              <Badge>{t("approvalPending")}</Badge>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAttempt((v) => v + 1)}
            >
              {t("refresh")}
            </Button>
          </div>
          {view === "work-orders" ? (
            <p className="text-sm text-slate-500">
              {t(
                visibleData.record.status === "draft"
                  ? "draftNote"
                  : "releasedNote",
              )}
            </p>
          ) : view === "mrp" ? (
            <p className="text-sm text-slate-500">{t("mrpNote")}</p>
          ) : null}
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {recordCommands(view, visibleData, options, canPost, canBuy).map(
                (action) => (
                  <Button
                    key={action.key}
                    size="sm"
                    variant={action.key === "release" ? "default" : "outline"}
                    disabled={!!command}
                    onClick={() => openCommand(action)}
                  >
                    {t("actions." + action.key)}
                  </Button>
                ),
              )}
            </div>
          ) : null}
          {activeCommand ? (
            <CommandForm
              key={activeCommand.path + activeCommand.key}
              command={activeCommand}
              data={visibleData}
              onSaved={saved}
              onCancel={cancelCommand}
              onReview={() => {
                cancelCommand();
                setAttempt((v) => v + 1);
                router.refresh();
              }}
            />
          ) : null}
          <RecordTabs
            label={t("recordTabs")}
            active={tab}
            tabs={tabs.map((key) => ({
              key,
              label: t("tabs." + key),
              ...(visibleData.sections[key]
                ? { count: visibleData.sections[key]!.length }
                : {}),
            }))}
            onChange={(value) => {
              setTab(value);
              setSelected(null);
            }}
          >
            {tab === "summary" ? (
              <dl className="grid gap-4 py-4 sm:grid-cols-2">
                {summaryKeys[view].map((key) => (
                  <div key={key}>
                    <dt className="text-xs font-medium text-slate-500">
                      {t("fields." + key)}
                    </dt>
                    <dd className="mt-1 break-words text-sm">
                      {reference(key, visibleData.record[key])}
                    </dd>
                  </div>
                ))}
                {view === "mrp" ? (
                  <div>
                    <dt className="text-xs font-medium text-slate-500">
                      {t("fields.subsidiaryId")}
                    </dt>
                    <dd className="mt-1 text-sm">
                      {reference(
                        "subsidiaryId",
                        (
                          visibleData.record.parameters as Record<
                            string,
                            unknown
                          >
                        )?.subsidiaryId,
                      )}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : (
              <div className="space-y-3 py-4">
                {tab === "capacity" ? (
                  <p className="text-sm text-slate-500">{t("capacityNote")}</p>
                ) : tab === "scrap" ? (
                  <p className="text-sm text-slate-500">
                    {t("normalScrapNote")}
                  </p>
                ) : tab === "operations" && view === "work-orders" ? (
                  <p className="text-sm text-slate-500">{t("operationNote")}</p>
                ) : null}
                <PagedTable
                  source="manufacturing_record_rows"
                  rows={activeRows}
                  columns={childColumns.map((key) => ({
                    key,
                    header: t("fields." + key),
                    cell: (row: ManufacturingRow) =>
                      key === "workCenterId"
                        ? reference("workCenterId", row[key])
                        : cell(key, row),
                    search: (row: ManufacturingRow) => label(row[key]),
                  }))}
                  rowKey={(row) => row.id}
                  empty={
                    <EmptyState
                      title={t("emptyChildren")}
                      description={t("emptyChildrenNote")}
                    />
                  }
                  searchable
                  onRowClick={(row) => setSelected(row)}
                  rowLabel={(row) =>
                    t("selectRecord", {
                      name: String(
                        row.name ??
                          row.itemName ??
                          row.itemCode ??
                          row.number ??
                          row.id,
                      ),
                    })
                  }
                  rowRole="button"
                  rowSelected={(row) => selected?.id === row.id}
                  rowInteractive={(row) =>
                    canManage &&
                    childCommands(
                      view,
                      tab,
                      visibleData.record,
                      row,
                      options,
                      canPost,
                      canBuy,
                    ).length > 0
                  }
                />
                {selected && rowCommands.length ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-slate-500">
                      {String(
                        selected.name ??
                          selected.itemName ??
                          selected.itemCode ??
                          selected.machineRatePerHour ??
                          "",
                      )}
                    </span>
                    {rowCommands.map((action) => (
                      <Button
                        key={action.key}
                        size="sm"
                        variant="outline"
                        disabled={!!command}
                        onClick={() => openCommand(action)}
                      >
                        {t("actions." + action.key)}
                      </Button>
                    ))}
                  </div>
                ) : null}
                {tab === "suggestions" ? (
                  <p className="text-xs text-slate-500">
                    {t("suggestionNote")}
                  </p>
                ) : null}
              </div>
            )}
          </RecordTabs>
        </div>
      ) : null}
    </AsyncUrlDrawer>
  );
}
