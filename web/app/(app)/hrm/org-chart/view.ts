import "server-only";

import { registeredListTable } from "../../../../lib/list/prepared-spec";

import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  column,
  grid,
  field,
  link,
  page,
  pageHeader,
  pagination,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import {
  loadOrgChartHome,
  orgChartAuthz,
} from "../../../../lib/hrm/org-chart-home";

/**
 * The editor uses the same bare canvas composition as the native FlowBuilder.
 * The optional directory keeps its registered list and house page layout.
 */

const f = field;
const item = field;

export type OrgChartPageData = NonNullable<
  Awaited<ReturnType<typeof loadOrgChartHome>>
>;

export function orgChartSpec(data: OrgChartPageData): PageSpec {
  const toolbar = {
    basePath: "/hrm/org-chart",
    currentParams: data.currentParams,
    search: { paramKey: "q", placeholder: data.searchLabel },
    date: {
      paramKey: "asOf",
      label: data.asOfLabel,
      max: data.today,
      resolved: data.asOf,
    },
    filters: [
      {
        paramKey: "view",
        label: data.treeLabel,
        allLabel: data.treeLabel,
        options: [{ value: "directory", label: data.directoryLabel }],
      },
    ],
  };
  return page({
    route: "/hrm/org-chart",
    layout: data.view === "directory" ? "list" : "bare",
    bodyClassName: "flex h-full min-h-0 flex-col",
    header: data.view === "directory" ? [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center gap-3",
      }),
    ] : [],
    body: [
      grid(data.view === "directory" ? "flex h-full min-h-0 flex-col gap-4" : "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden", [
        // An impossible bookmarked date corrects to the business date in
        // the loader; the correction is named above the chart, never
        // silent and never a route error.
        {
          ...widgetBlock("empty-state", {
            title: data.dateRefusal?.title ?? "",
            description: data.dateRefusal?.description ?? "",
          }),
          when: f("dateRefusal"),
        },
        ...(data.view === "directory"
          ? [
              // The directory uses one registered list and toolbar. The
              // domain reader owns its server window and authorization.
              grid("min-h-0 flex-1 overflow-y-auto", [
                registeredListTable(
                  "hrm_org_chart_directory",
                  {
                    variant: "app",
                    rows: f("directoryRows"),
                    rowKey: item("id"),
                    empty: { title: f("directoryEmpty") },
                    columns: [
                      column(
                        data.directoryColumns.name,
                        link(item("name"), item("href")),
                      ),
                      column(
                        data.directoryColumns.title,
                        text(item("title"), { fallback: "—" }),
                      ),
                      column(
                        data.directoryColumns.department,
                        text(item("department"), { fallback: "—" }),
                      ),
                      column(
                        data.directoryColumns.manager,
                        text(item("manager"), { fallback: "—" }),
                      ),
                    ],
                  },
                  [widget("list-toolbar", toolbar)],
                ),
              ]),
              pagination({
                basePath: "/hrm/org-chart",
                total: f("directoryTotal"),
                page: f("directoryPage"),
                perPage: f("directoryPageSize"),
                bare: true,
              }),
            ]
          : [
              grid("min-h-0 flex-1", [
                widgetBlock("org-chart-tree", {
                  chart: data.chart,
                  layout: data.layout,
                  canEditLayout: data.canEditLayout,
                  personBaseHref: data.personBaseHref,
                  labels: data.labels,
                  canManage: data.canManage,
                  today: data.today,
                  departmentOptions: data.departmentOptions,
                }),
              ]),
            ]),
      ]),
      {
        ...widgetBlock("hrm-org-chart-person", {
          selected: data.selected,
          manager: data.manager,
          canManage: data.canManage,
          canReadEmployee: data.canReadEmployee,
          today: data.today,
          departmentOptions: data.departmentOptions,
          closeHref: data.personCloseHref,
          labels: data.labels,
        }),
        when: f("selected"),
      },
    ],
  });
}

export async function orgChartTitle(): Promise<string> {
  const t = await getTranslations("hrm");
  return t("orgChart.title");
}

export async function loadOrgChartPage(sp: Record<string, string | undefined>) {
  const authz = await orgChartAuthz();
  if (!authz) notFound();
  return loadOrgChartHome(authz, sp);
}
