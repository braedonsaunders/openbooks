"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Badge, Button, EmptyState, PageHeader } from "@openbooks/ui";
import type { SalesRecord, SalesWorkspaceData } from "@openbooks/engine/crm/sales/contracts";
import { ListPageLayout } from "@/components/page-layout";
import { PagedTable, type PagedColumn } from "@/components/paged-table";
import { Pagination } from "@/components/pagination";
import { HomePanel, HomeStatTile } from "@/components/module-home/client";
import { LiveDirectory, type DirectoryItem, ModuleHomeTabs } from "@/components/module-home/ui";
import { useMoney } from "@/components/money-provider";
import { FilterChips } from "@/components/filter-bar";
import { ListFilterSelect } from "@/components/list-filter-select";
import { SearchInput } from "@/components/search-input";
import { mergeHref } from "@/lib/list-params";
import { SalesDrawer } from "./SalesDrawer";
import { DateField } from "@/components/date-field";
const TerritoryMap = dynamic(() => import("./TerritoryMap").then((m) => m.TerritoryMap), {
  ssr: false,
  loading: () => <div className="h-96 animate-pulse rounded-xl bg-slate-100" />,
});
function Amount({ amount, currency }: { amount: string; currency: string }) {
  const { money } = useMoney(currency);
  return <span className="font-semibold tabular-nums">{money(amount)}</span>;
}
export function SalesWorkspace({
  data,
  params,
}: {
  data: SalesWorkspaceData;
  params: Record<string, string | undefined>;
}) {
  const t = useTranslations("crm.sales");
  const locale = useLocale();
  const router = useRouter();
  const base = data.page === "overview" ? "/crm/sales" : `/crm/sales/${data.page}`;
  const href = (values: Record<string, string | number | null>) => mergeHref(base, params, values);
  const tabs = [
    { href: "/crm/sales", label: t("tabs.overview"), active: data.page === "overview" },
    {
      href: "/crm/sales/representatives",
      label: t("tabs.representatives"),
      active: data.page === "representatives",
    },
    { href: "/crm/sales/teams", label: t("tabs.teams"), active: data.page === "teams" },
    { href: "/crm/sales/quotas", label: t("tabs.quotas"), active: data.page === "quotas" },
    {
      href: "/crm/sales/territories",
      label: t("tabs.territories"),
      active: data.page === "territories",
    },
  ];
  const territoryFilters =
    data.page === "territories" ? (
      <>
        <ListFilterSelect
          basePath={base}
          currentParams={params}
          paramKey="department"
          label={t("department")}
          allLabel={t("allDepartments")}
          options={data.departments.map(({ id, name }) => ({ value: id, label: name }))}
        />
        <ListFilterSelect
          basePath={base}
          currentParams={params}
          paramKey="salesTeam"
          label={t("team")}
          allLabel={t("allTeams")}
          options={data.teams.map(({ id, name }) => ({ value: id, label: name }))}
        />
        <ListFilterSelect
          basePath={base}
          currentParams={params}
          paramKey="subsidiary"
          label={t("legalEntity")}
          allLabel={t("allEntities")}
          options={data.subsidiaries.map(({ id, name }) => ({ value: id, label: name }))}
        />
        <ListFilterSelect
          basePath={base}
          currentParams={params}
          paramKey="salesRep"
          label={t("representative")}
          allLabel={t("allRepresentatives")}
          options={data.representatives.map(({ id, name }) => ({ value: id, label: name }))}
        />
        {data.mapEnabled ? (
          <FilterChips
            basePath={base}
            currentParams={params}
            paramKey="view"
            label={t("view")}
            defaultValue="list"
            hideAll
            options={[
              { value: "list", label: t("list") },
              { value: "map", label: t("map") },
            ]}
          />
        ) : null}
      </>
    ) : null;
  const listToolbar =
    data.page !== "overview" ? (
      <>
        <SearchInput placeholder={t("search")} />
        {territoryFilters}
      </>
    ) : undefined;
  const columns: PagedColumn<SalesRecord>[] = [
    {
      key: "name",
      header: t("name"),
      cell: (r) => (
        <div>
          <div className="font-medium text-slate-900 dark:text-slate-100">{r.name}</div>
          <div className="text-xs text-slate-500">
            {data.subsidiaries.find((s) => s.id === r.subsidiary_id)?.name ?? t("legacyScope")}
          </div>
        </div>
      ),
    },
  ];
  if (data.page === "representatives")
    columns.push(
      {
        key: "number",
        header: t("employeeNumber"),
        cell: (r) => r.employee_number ?? "—",
      },
      {
        key: "eligibility",
        header: t("status"),
        cell: (r) => (
          <Badge variant={r.is_sales_rep ? "success" : "secondary"}>
            {r.is_sales_rep ? t("eligible") : t("notDesignated")}
          </Badge>
        ),
      },
      {
        key: "since",
        header: t("effectiveFrom"),
        cell: (r) => r.sales_rep_since ?? "—",
      },
    );
  if (data.page === "teams")
    columns.push(
      {
        key: "manager",
        header: t("manager"),
        cell: (r) => r.manager_name ?? "—",
      },
      {
        key: "members",
        header: t("members"),
        cell: (r) => r.member_count ?? 0,
      },
      {
        key: "status",
        header: t("status"),
        cell: (r) => (
          <Badge variant={r.is_active ? "success" : "secondary"}>
            {r.is_active ? t("active") : t("archived")}
          </Badge>
        ),
      },
    );
  if (data.page === "quotas")
    columns.push(
      {
        key: "target",
        header: t("target"),
        cell: (r) => r.employee_name ?? "—",
      },
      {
        key: "period",
        header: t("period"),
        cell: (r) => (
          <span className="text-xs">
            {r.period_start} → {r.period_end}
          </span>
        ),
      },
      {
        key: "metric",
        header: t("metric"),
        cell: (r) => t(r.metric ?? "closed_won"),
      },
      {
        key: "amount",
        header: t("quota"),
        align: "right",
        cell: (r) => <Amount amount={r.amount ?? "0"} currency={r.currency ?? data.baseCurrency} />,
      },
      {
        key: "actual",
        header: t("actual"),
        align: "right",
        cell: (r) => <Amount amount={r.actual ?? "0"} currency={r.currency ?? data.baseCurrency} />,
      },
      {
        key: "status",
        header: t("status"),
        cell: (r) => (
          <Badge variant={r.lifecycle === "approved" ? "success" : "secondary"}>
            {t(r.lifecycle ?? "draft")}
          </Badge>
        ),
      },
    );
  if (data.page === "territories")
    columns.push(
      {
        key: "rep",
        header: t("representative"),
        cell: (r) => r.employee_name ?? "—",
      },
      {
        key: "coverage",
        header: t("coverage"),
        cell: (r) =>
          t("coverageCount", {
            count:
              (r.geography?.includes.length ?? 0) +
              (r.geography?.polygons.length ?? 0) +
              (r.rules?.length ?? 0),
          }),
      },
      {
        key: "effective",
        header: t("effectiveFrom"),
        cell: (r) => r.effective_from,
      },
      {
        key: "status",
        header: t("status"),
        cell: (r) => (
          <Badge variant={r.lifecycle === "active" ? "success" : "secondary"}>
            {t(r.lifecycle ?? "draft")}
          </Badge>
        ),
      },
    );
  return (
    <ListPageLayout
      header={
        <>
          <PageHeader
            title={t(`tabs.${data.page}`)}
            description={t("description")}
            actions={
              <>
                {data.canManage && data.page !== "overview" ? (
                  <Button onClick={() => router.push(href({ row: "new" }))}>
                    {t(
                      (
                        {
                          representatives: "designate",
                          teams: "newTeam",
                          quotas: "newQuota",
                          territories: "newTerritory",
                        } as const
                      )[data.page as "representatives" | "teams" | "quotas" | "territories"],
                    )}
                  </Button>
                ) : null}
                <ModuleHomeTabs tabs={tabs} />
              </>
            }
          />
        </>
      }
      className="space-y-6"
    >
      {data.page === "overview" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(["representatives", "teams", "territories", "draftQuotas"] as const).map((key, i) => (
              <Link key={key} href={`/crm/sales/${key === "draftQuotas" ? "quotas" : key}`}>
                <HomeStatTile
                  icon={["users", "briefcase", "building", "badge-dollar"][i]!}
                  label={t(key)}
                  value={String(data.counts[key])}
                  sub={t("openWorkspace")}
                  accent={(["teal", "sky", "violet", "amber"] as const)[i]}
                />
              </Link>
            ))}
          </div>
          <div className="grid gap-6 xl:grid-cols-[1.8fr_1fr]">
            <HomePanel
              title={t("performance")}
              icon="trending-up"
              actions={
                <Link className="text-sm text-teal-700" href={data.reports.quota}>
                  {t("viewReport")}
                </Link>
              }
            >
              <form action={base} className="mb-5 flex flex-wrap items-end gap-3">
                <label className="text-xs">
                  {t("from")}
                  <DateField name="periodStart" defaultValue={data.periodStart} />
                </label>
                <label className="text-xs">
                  {t("to")}
                  <DateField name="periodEnd" defaultValue={data.periodEnd} />
                </label>
                <Button variant="outline" type="submit">
                  {t("apply")}
                </Button>
              </form>
              {data.summary.length ? (
                <div className="grid gap-4 md:grid-cols-2">
                  {data.summary.map((s) => (
                    <div
                      key={s.currency + s.metric}
                      className="rounded-xl bg-slate-50 p-5 dark:bg-slate-950"
                    >
                      <p className="text-xs uppercase tracking-wider text-slate-500">
                        {t(s.metric)} · {s.currency}
                      </p>
                      <p className="my-3 text-3xl">
                        <Amount amount={s.actual} currency={s.currency} />
                      </p>
                      <p className="text-sm text-slate-500">
                        {t("approvedTarget")} <Amount amount={s.quota} currency={s.currency} />
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState title={t("noEvidence")} description={t("evidenceDescription")} />
              )}
            </HomePanel>
            <div className="space-y-6">
              <HomePanel title={t("attention")} icon="triangle-alert">
                <p className="mb-3 text-sm">
                  {t("unattributedCount", { count: data.counts.unattributed })}
                </p>
                <p className="mb-4 text-sm">{t("undatedCount", { count: data.counts.undated })}</p>
                <Link className="text-sm font-medium text-teal-700" href={data.reports.evidence}>
                  {t("reviewEvidence")}
                </Link>
              </HomePanel>
              <HomePanel title={t("planning")} icon="clipboard">
                <LiveDirectory
                  items={
                    [
                      {
                        href: "/crm/sales/representatives",
                        label: t("tabs.representatives"),
                        iconKey: "users",
                        badge: {
                          value: new Intl.NumberFormat(locale).format(data.counts.representatives),
                        },
                      },
                      {
                        href: "/crm/sales/teams",
                        label: t("tabs.teams"),
                        iconKey: "briefcase-business",
                        badge: { value: new Intl.NumberFormat(locale).format(data.counts.teams) },
                      },
                      {
                        href: "/crm/sales/quotas",
                        label: t("tabs.quotas"),
                        iconKey: "circle-dollar-sign",
                        badge: {
                          value: new Intl.NumberFormat(locale).format(data.counts.draftQuotas),
                        },
                      },
                      {
                        href: "/crm/sales/territories",
                        label: t("tabs.territories"),
                        iconKey: "building",
                        badge: {
                          value: new Intl.NumberFormat(locale).format(data.counts.territories),
                        },
                      },
                    ] satisfies DirectoryItem[]
                  }
                />
              </HomePanel>
            </div>
          </div>
        </>
      ) : (
        <>
          {data.page === "territories" && params.view === "map" && data.mapEnabled ? (
            <div className="flex flex-wrap items-end gap-2">{listToolbar}</div>
          ) : null}
          {data.page === "territories" && params.view === "map" && data.mapEnabled ? (
            <p className="text-xs text-slate-500">
              {t("customerMapSummary", {
                shown: data.customerLocations.length,
                located: data.customerLocationStats.located,
                missing: data.customerLocationStats.total - data.customerLocationStats.located,
              })}{" "}
              ·{" "}
              {t("territoryMapSummary", {
                shown: data.mapTerritories.length,
                total: data.total,
              })}
            </p>
          ) : null}
          {data.page === "territories" && params.view === "map" && data.mapEnabled ? (
            <TerritoryMap
              territories={data.mapTerritories}
              customers={data.customerLocations}
              onTerritoryClick={(id) => router.push(href({ row: id }))}
            />
          ) : (
            <PagedTable
              source={`crm_sales_${data.page}`}
              rows={data.rows}
              columns={columns}
              rowKey={(r) => r.id}
              onRowClick={(r) => router.push(href({ row: r.id }))}
              rowLabel={(r) => r.name}
              empty={<EmptyState title={t("emptyTitle")} description={t("emptyDescription")} />}
              emptyAsRow
              toolbarAfter={listToolbar}
            />
          )}
          {data.total > 0 ? (
            <Pagination
              basePath={base}
              currentParams={params}
              total={data.total}
              page={data.currentPage}
              perPage={data.perPage}
            />
          ) : null}
        </>
      )}
      {(data.selected || data.creating) && data.page !== "overview" ? (
        <SalesDrawer
          key={data.creating ? "new-" + (data.selected?.id ?? "") : (data.selected?.id ?? "new")}
          data={data}
          closeHref={href({ row: null, employee: null })}
        />
      ) : null}
    </ListPageLayout>
  );
}
