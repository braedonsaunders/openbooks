"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { InsuredValueRow } from "@openbooks/engine/assets/asset-insurance";
import { Badge, Button } from "@openbooks/ui";
import { PagedTable, type PagedColumn } from "@/components/paged-table";
import { ModuleHomeTabs } from "@/components/module-home/ui";
import { useMoney } from "@/components/money-provider";
import { mergeHref } from "@/lib/list-params";
import type { InsuranceData, PolicyRow } from "./_data";
import { PolicyDrawer } from "./PolicyDrawer";

const STANDING_VARIANT = {
  underinsured: "destructive",
  matched: "secondary",
  overinsured: "warning",
} as const;

export function NewPolicyButton({
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
          mergeHref("/assets/insurance", currentParams, { tab: "policies", policy: "new" }),
        )
      }
    >
      {t("insurance.new")}
    </Button>
  );
}

export function InsuranceWorkspace({
  data,
  currentParams,
}: {
  data: InsuranceData;
  currentParams: Record<string, string | string[] | undefined>;
}) {
  const t = useTranslations("assets");
  const { money } = useMoney();
  const router = useRouter();
  const tabs = [
    {
      key: "policies",
      href: "/assets/insurance",
      label: t("insurance.tabs.policies"),
      active: data.tab === "policies",
    },
    {
      key: "values",
      href: "/assets/insurance?tab=values",
      label: t("insurance.tabs.values"),
      active: data.tab === "values",
    },
  ];
  const columns: PagedColumn<PolicyRow>[] = [
    {
      key: "number",
      header: t("insurance.columns.policyNumber"),
      cell: (row) => <span className="font-mono text-[13px]">{row.policyNumber}</span>,
      search: (row) => row.policyNumber,
    },
    {
      key: "insurer",
      header: t("insurance.columns.insurer"),
      cell: (row) => row.insurerName,
      search: (row) => row.insurerName,
    },
    {
      key: "entity",
      header: t("insurance.columns.legalEntity"),
      cell: (row) => row.subsidiaryName,
    },
    {
      key: "period",
      header: t("insurance.columns.coverage"),
      cell: (row) => `${row.coverageStartsOn} – ${row.coverageEndsOn}`,
    },
    {
      key: "covered",
      header: t("insurance.columns.covered"),
      align: "right",
      cell: (row) => row.covered,
    },
    {
      key: "insured",
      header: t("insurance.columns.insuredTotal"),
      align: "right",
      cell: (row) => (
        <span className="tabular-nums">{money(row.insuredTotal, { currency: row.currency })}</span>
      ),
    },
    {
      key: "premium",
      header: t("insurance.columns.premium"),
      align: "right",
      cell: (row) => (
        <span className="tabular-nums">{money(row.premium, { currency: row.currency })}</span>
      ),
    },
    {
      key: "status",
      header: t("insurance.columns.status"),
      cell: (row) => (
        <Badge
          variant={
            row.status === "cancelled"
              ? "secondary"
              : row.coverageEndsOn < data.today
                ? "destructive"
                : row.renewed
                  ? "success"
                  : "default"
          }
        >
          {row.status === "cancelled"
            ? t("insurance.status.cancelled")
            : row.coverageEndsOn < data.today
              ? t("insurance.status.expired")
              : row.renewed
                ? t("insurance.status.renewed")
                : t("insurance.status.active")}
        </Badge>
      ),
    },
  ];
  const valueColumns: PagedColumn<InsuredValueRow>[] = [
    {
      key: "asset",
      header: t("insurance.columns.asset"),
      cell: (row) => (
        <span>
          <span className="font-mono text-[13px]">{row.assetNumber}</span> {row.assetName}
        </span>
      ),
      search: (row) => `${row.assetNumber} ${row.assetName}`,
    },
    {
      key: "policy",
      header: t("insurance.columns.policyNumber"),
      cell: (row) => row.policyNumber,
      search: (row) => row.policyNumber,
    },
    {
      key: "insured",
      header: t("insurance.columns.insuredValue"),
      align: "right",
      cell: (row) => (
        <span className="tabular-nums">{money(row.insuredValue, { currency: row.currency })}</span>
      ),
    },
    {
      key: "replacement",
      header: t("insurance.columns.replacementValue"),
      align: "right",
      cell: (row) =>
        row.replacementValue ? (
          <span className="tabular-nums">
            {money(row.replacementValue, { currency: row.currency })}
          </span>
        ) : (
          "—"
        ),
    },
    {
      key: "nbv",
      header: t("insurance.columns.netBookValue"),
      align: "right",
      cell: (row) => (
        <span className="tabular-nums">{money(row.netBookValue, { currency: row.currency })}</span>
      ),
    },
    {
      key: "gap",
      header: t("insurance.columns.gap"),
      align: "right",
      cell: (row) => (
        <span className="tabular-nums">{money(row.gap, { currency: row.currency })}</span>
      ),
    },
    {
      key: "standing",
      header: t("insurance.columns.standing"),
      cell: (row) => (
        <Badge variant={STANDING_VARIANT[row.standing]}>
          {t(`insurance.standing.${row.standing}`)}
        </Badge>
      ),
    },
  ];
  return (
    <div className="space-y-4">
      <ModuleHomeTabs tabs={tabs} placement="local" ariaLabel={t("insurance.tabsAria")} />
      {data.tab === "policies" ? (
        <PagedTable
          rows={data.rows}
          columns={columns}
          source="asset_insurance_policies"
          searchable
          pageSize={25}
          rowKey={(row) => row.id}
          onRowClick={(row) =>
            router.push(mergeHref("/assets/insurance", currentParams, { policy: row.id }))
          }
          rowLabel={(row) => `${row.policyNumber} ${row.insurerName}`}
          rowSelected={(row) => row.id === data.selected?.id}
          empty={
            <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              {t("insurance.empty")}
            </p>
          }
          emptyAsRow
        />
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            {t("insurance.valuesHelp", { date: data.today })}
          </p>
          <PagedTable
            rows={data.comparison}
            columns={valueColumns}
            source="asset_insured_values"
            searchable
            pageSize={25}
            rowKey={(row) => `${row.policyId}:${row.assetId}`}
            empty={
              <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
                {t("insurance.valuesEmpty")}
              </p>
            }
            emptyAsRow
          />
        </div>
      )}
      {data.createMode ? (
        <PolicyDrawer
          key="new"
          policy={null}
          createMode
          data={data}
          closeHref={mergeHref("/assets/insurance", currentParams, { policy: undefined })}
        />
      ) : data.selected ? (
        <PolicyDrawer
          key={`${data.selected.id}:${data.selected.updatedAt}`}
          policy={data.selected}
          data={data}
          closeHref={mergeHref("/assets/insurance", currentParams, { policy: undefined })}
        />
      ) : null}
    </div>
  );
}
