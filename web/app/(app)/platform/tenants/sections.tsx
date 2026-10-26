import { PagedTable } from "../../../../components/paged-table";
import { PageHeader } from "@openbooks/ui";
import { ListPageLayout } from "../../../../components/page-layout";
import { SearchInput } from "../../../../components/search-input";
import { FilterChips } from "../../../../components/filter-bar";
import type { PlatformOrganization } from "../../../../lib/platform-admin";
import {
  OrgEnvironmentCell,
  OrgLocaleCell,
  OrgNameCell,
  OrgOpenCell,
  OrgUsersCell,
} from "../organizations/sections";
import { NewOrganizationButton } from "./NewOrganizationDrawer";
import { getTranslations } from "next-intl/server";

const ENV_VARIANT = {
  production: "success",
  sandbox: "warning",
  preview: "secondary",
} as const;

/**
 * The operator organizations list on the house list composition — the same
 * shape RecordListView renders for every tenant list (toolbar + sortable
 * table + pager), driven server-side by platformOrganizations.
 *
 * It replaces the AppKit tenants table, which sorted and filtered
 * client-side over the one fetched page: everything past the first page was
 * unreachable from search AND from sort, while reading as the whole tenant list.
 * Sort, search, the environment filter and the page size all travel on the
 * URL through the house list-params helpers, so refreshes and shared links
 * hold. The row cells stay the shared organizations/sections cells the
 * viewspec platform widgets also render — one row rendering, not two.
 */
export async function TenantsList({
  rows,
  total,
  page,
  perPage,
  sort,
  dir,
  environment,
  environmentCounts,
  basePath,
  currentParams,
}: {
  rows: PlatformOrganization[];
  total: number;
  page: number;
  perPage: number;
  sort: "name" | "environment" | "users" | "sandboxes" | "created";
  dir: "asc" | "desc";
  environment: "production" | "sandbox" | "preview" | undefined;
  environmentCounts: Record<string, number>;
  basePath: string;
  currentParams: Record<string, string | string[] | undefined>;
}) {
  const t = await getTranslations("platform.tenants");
  const filtered = currentParams.q !== undefined || environment !== undefined;
  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("title")}
          description={t("description")}
          back={{ href: "/platform", label: t("backToPlatform") }}
          actions={<NewOrganizationButton basePath={basePath} />}
        />
      }
    >
      <div className="space-y-5">
        <PagedTable
          rows={rows}
          rowKey={(row) => row.id}
          serverWindow={{ total, page, perPage }}
          basePath={basePath}
          currentParams={currentParams}
          sort={sort}
          dir={dir}
          empty={filtered ? t("emptyFiltered") : t("empty")}
          toolbarAfter={
            <>
              <SearchInput placeholder={t("searchPlaceholder")} />
              <FilterChips
                basePath={basePath}
                currentParams={currentParams}
                paramKey="environment"
                label={t("environment")}
                options={(["production", "sandbox", "preview"] as const).map((value) => ({
                  value,
                  label: t(`environments.${value}`),
                  count: Number(environmentCounts[value] ?? 0),
                }))}
              />
            </>
          }
          columns={[
            {
              key: "name",
              header: t("columns.organization"),
              sortKey: "name",
              cell: (org) => <OrgNameCell name={org.name} subtitle={org.legalName ?? ""} />,
            },
            {
              key: "environment",
              header: t("environment"),
              sortKey: "environment",
              cell: (org) => (
                <OrgEnvironmentCell
                  envKind={org.envKind}
                  variant={ENV_VARIANT[org.envKind]}
                  parentNote={org.parentName ? t("parentNote", { name: org.parentName }) : ""}
                />
              ),
            },
            {
              key: "locale",
              header: t("columns.locale"),
              cell: (org) => <OrgLocaleCell country={org.country} currency={org.baseCurrency} />,
            },
            {
              key: "users",
              header: t("columns.users"),
              sortKey: "users",
              cell: (org) => (
                <OrgUsersCell active={String(org.activeUserCount)} total={String(org.userCount)} />
              ),
            },
            {
              key: "sandboxes",
              header: t("columns.sandboxes"),
              sortKey: "sandboxes",
              align: "right",
              cell: (org) => org.sandboxCount,
            },
            {
              key: "open",
              header: <span className="sr-only">{t("open")}</span>,
              className: "w-px whitespace-nowrap px-2 text-center",
              style: { width: 64 },
              cell: (org) =>
                org.envKind === "production" ? (
                  <OrgOpenCell orgId={org.id} />
                ) : (
                  <span className="text-slate-300 dark:text-slate-600" title={t("productionOnly")}>
                    —
                  </span>
                ),
            },
          ]}
        />
      </div>
    </ListPageLayout>
  );
}
