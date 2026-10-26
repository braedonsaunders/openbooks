"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Button, Label } from "@openbooks/ui";
import { PagedTable, type PagedColumn } from "@/components/paged-table";
import { ModuleHomeTabs } from "@/components/module-home/ui";
import { useMoney } from "@/components/money-provider";
import { mergeHref } from "@/lib/list-params";
import type { CipRecordRow, ConstructionData } from "./_data";
import { CipDrawer } from "./CipDrawer";
import { DateField } from "@/components/date-field";

/** Open a construction-in-progress record on its CIP account. */
export function NewCipButton({
  currentParams,
}: {
  currentParams: Record<string, string | string[] | undefined>;
}) {
  const t = useTranslations("assets");
  const router = useRouter();
  return (
    <Button
      onClick={() =>
        router.push(
          mergeHref("/assets/construction", currentParams, { tab: "records", cip: "new" }),
        )
      }
    >
      {t("construction.new")}
    </Button>
  );
}

export function ConstructionWorkspace({
  data,
  currentParams,
}: {
  data: ConstructionData;
  currentParams: Record<string, string | string[] | undefined>;
}) {
  const t = useTranslations("assets");
  const { money } = useMoney();
  const router = useRouter();
  const tabs = [
    {
      key: "records",
      href: "/assets/construction",
      label: t("construction.tabs.records"),
      active: data.tab === "records",
    },
    {
      key: "reconciliation",
      href: "/assets/construction?tab=reconciliation",
      label: t("construction.tabs.reconciliation"),
      active: data.tab === "reconciliation",
    },
  ];
  const columns: PagedColumn<CipRecordRow>[] = [
    {
      key: "number",
      header: t("construction.columns.number"),
      cell: (row) => <span className="font-mono text-[13px]">{row.assetNumber}</span>,
      search: (row) => row.assetNumber,
    },
    {
      key: "name",
      header: t("construction.columns.name"),
      cell: (row) => row.name,
      search: (row) => row.name,
    },
    {
      key: "entity",
      header: t("construction.columns.legalEntity"),
      cell: (row) => row.subsidiaryName,
    },
    { key: "account", header: t("construction.columns.account"), cell: (row) => row.accountLabel },
    {
      key: "linked",
      header: t("construction.columns.linked"),
      align: "right",
      cell: (row) => <span className="tabular-nums">{money(row.linked)}</span>,
    },
    {
      key: "capitalized",
      header: t("construction.columns.capitalized"),
      align: "right",
      cell: (row) => <span className="tabular-nums">{money(row.capitalized)}</span>,
    },
    {
      key: "expensed",
      header: t("construction.columns.expensed"),
      align: "right",
      cell: (row) => <span className="tabular-nums">{money(row.expensed)}</span>,
    },
    {
      key: "open",
      header: t("construction.columns.open"),
      align: "right",
      cell: (row) => <strong className="tabular-nums">{money(row.open)}</strong>,
    },
    {
      key: "status",
      header: t("construction.columns.status"),
      cell: (row) => (
        <Badge variant={row.status === "construction" ? "warning" : "success"}>
          {t(`status.${row.status}`)}
        </Badge>
      ),
    },
  ];
  return (
    <div className="space-y-4">
      <ModuleHomeTabs tabs={tabs} placement="local" ariaLabel={t("construction.tabsAria")} />
      {data.tab === "records" ? (
        <PagedTable
          rows={data.rows}
          columns={columns}
          source="asset_cip_records"
          searchable
          pageSize={25}
          rowKey={(row) => row.id}
          onRowClick={(row) =>
            router.push(mergeHref("/assets/construction", currentParams, { cip: row.id }))
          }
          rowLabel={(row) => `${row.assetNumber} ${row.name}`}
          rowSelected={(row) => row.id === data.selected?.id}
          empty={
            <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              {t("construction.empty")}
            </p>
          }
          emptyAsRow
        />
      ) : (
        <div className="space-y-3">
          <form className="flex items-end gap-2" action="/assets/construction">
            <input type="hidden" name="tab" value="reconciliation" />
            <div className="space-y-1.5">
              <Label htmlFor="recon-as-of">{t("construction.fields.asOf")}</Label>
              <DateField id="recon-as-of" name="asOf" defaultValue={data.asOf} />
            </div>
            <Button type="submit" variant="outline">
              {t("construction.refresh")}
            </Button>
          </form>
          <PagedTable
            rows={data.reconciliation}
            source="asset_cip_reconciliation"
            rowKey={(row) => `${row.subsidiaryId}:${row.accountId}`}
            columns={[
              {
                key: "account",
                header: t("construction.columns.account"),
                cell: (row) => [row.accountNumber, row.accountName].filter(Boolean).join(" · "),
              },
              {
                key: "entity",
                header: t("construction.columns.legalEntity"),
                cell: (row) => row.subsidiaryName,
              },
              {
                key: "subledger",
                header: t("construction.columns.subledger"),
                align: "right",
                cell: (row) => <span className="tabular-nums">{money(row.subledger)}</span>,
              },
              {
                key: "ledger",
                header: t("construction.columns.ledger"),
                align: "right",
                cell: (row) => <span className="tabular-nums">{money(row.ledger)}</span>,
              },
              {
                key: "difference",
                header: t("construction.columns.difference"),
                align: "right",
                cell: (row) => (
                  <span
                    className={
                      row.difference === "0.0000"
                        ? "tabular-nums text-slate-500"
                        : "font-semibold tabular-nums text-red-600 dark:text-red-400"
                    }
                  >
                    {money(row.difference)}
                  </span>
                ),
              },
            ]}
            empty={
              <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                {t("construction.reconciliationEmpty")}
              </p>
            }
            emptyAsRow
          />
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t("construction.reconciliationHelp")}
          </p>
        </div>
      )}
      {data.createMode ? (
        <CipDrawer
          key="new"
          record={null}
          createMode
          data={data}
          closeHref={mergeHref("/assets/construction", currentParams, { cip: undefined })}
        />
      ) : data.selected ? (
        <CipDrawer
          key={data.selected.id}
          record={data.selected}
          data={data}
          closeHref={mergeHref("/assets/construction", currentParams, { cip: undefined })}
        />
      ) : null}
    </div>
  );
}
