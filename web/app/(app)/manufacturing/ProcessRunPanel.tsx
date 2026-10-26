"use client";
import { useTranslations, useLocale } from "next-intl";
import { Button, EmptyState } from "@openbooks/ui";
import { PagedTable } from "@/components/paged-table";
import { formatDecimal } from "@/lib/money-format";
import { dateTime, formatCivilDate } from "@/lib/format";
import type {
  ManufacturingRecordData,
  ManufacturingRow,
} from "@openbooks/engine/manufacturing/workspace";

/** A scoped run view reads the same posted movements used by inventory and genealogy. */
export function ProcessRunPanel({
  data,
  onOpen,
}: {
  data: ManufacturingRecordData;
  onOpen: (tab: string) => void;
}) {
  const t = useTranslations("manufacturing"),
    locale = useLocale(),
    record = data.record;
  const quantity = (value: unknown) =>
    formatDecimal(locale, String(value ?? "0"), { maximumFractionDigits: 4 });
  const balanceCell = (key: string, format: (row: ManufacturingRow) => string) => ({
    key,
    header: t("fields." + key),
    cell: format,
    search: format,
  });
  const balanceColumns = [
    balanceCell("unit", (row) => String(row.unit)),
    balanceCell("inputQuantity", (row) => quantity(row.inputQuantity)),
    balanceCell("outputQuantity", (row) => quantity(row.outputQuantity)),
    balanceCell("measuredOutputQuantity", (row) =>
      row.measuredOutputQuantity == null ? "—" : quantity(row.measuredOutputQuantity),
    ),
    balanceCell("difference", (row) => quantity(row.difference)),
    balanceCell("differenceKind", (row) =>
      ["balanced", "measured_loss", "unreconciled"].includes(String(row.differenceKind))
        ? t("process.differenceKind." + String(row.differenceKind))
        : "—",
    ),
  ];
  return (
    <div className="space-y-5 py-4">
      <div className="rounded-xl border p-5">
        <h3 className="font-semibold">{t("process.title")}</h3>
        <p className="mt-2 max-w-3xl text-sm text-slate-500">{t("process.windowNote")}</p>
        <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ["productionMode", t("values." + record.productionMode)],
            ["campaignReference", String(record.campaignReference ?? "—")],
            [
              "plannedStart",
              record.plannedStart ? formatCivilDate(String(record.plannedStart), locale) : "—",
            ],
            [
              "plannedEnd",
              record.plannedEnd ? formatCivilDate(String(record.plannedEnd), locale) : "—",
            ],
            ["startedAt", record.startedAt ? dateTime(String(record.startedAt), locale) : "—"],
            [
              "completedAt",
              record.completedAt ? dateTime(String(record.completedAt), locale) : "—",
            ],
          ].map(([key, value]) => (
            <div key={key}>
              <dt className="text-xs text-slate-500">{t("fields." + key)}</dt>
              <dd className="mt-1 break-words text-sm">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="space-y-3">
        <h3 className="font-semibold">{t("process.balance")}</h3>
        <p className="max-w-3xl text-sm text-slate-500">{t("process.balanceNote")}</p>
        <PagedTable
          source="manufacturing_record_rows"
          rows={data.sections.materialBalance ?? []}
          columns={balanceColumns}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t("process.empty")} description={t("process.emptyNote")} />}
        />
      </div>
      <div className="rounded-xl border p-4">
        <h3 className="text-sm font-semibold">{t("process.carryover")}</h3>
        <p className="mt-2 max-w-3xl text-sm text-slate-500">{t("process.carryoverNote")}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => onOpen("receipts")}>
            {t("tabs.receipts")}
          </Button>
          <Button variant="outline" onClick={() => onOpen("issues")}>
            {t("tabs.issues")}
          </Button>
        </div>
      </div>
    </div>
  );
}
