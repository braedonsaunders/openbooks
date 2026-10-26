import "server-only";

import { getLocale, getTranslations } from "next-intl/server";
import {
  grid,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { serviceHomeSummary, type ServiceHomeSummary } from "@openbooks/engine/service/reads";
import { listBoards } from "@openbooks/engine/schedule-boards/boards";
import { boardHasCapability } from "@openbooks/engine/schedule-boards/board-types";
import { can } from "../../../lib/authz";
import { requireServiceArea } from "../../../lib/service/pages";
import { builtInReportDefinitionId } from "../../../lib/custom-reports";
import { serviceActor } from "../../../lib/service/authority";
import { serviceWorkspaceTabs } from "../../../lib/service/workspace-tabs";
import type { DirectoryItem } from "../../../components/module-home/ui";

/**
 * The service home: counts that need attention, the dispatch boards and the
 * service reports. Lists live on their own tabs (requests, jobs, visits,
 * agreements); this page links into them.
 */
export interface ServiceHomeData {
  title: string;
  description: string;
  summary: ServiceHomeSummary;
  canConfigure: boolean;
  canCreate: boolean;
  newLabel: string;
  tabs: ReturnType<typeof serviceWorkspaceTabs>;
  workTabs: ReturnType<typeof serviceWorkspaceTabs>;
  activeWork: "requests" | "visits";
  currentParams: Record<string, string | string[] | undefined>;
  directory: DirectoryItem[];
  attention: { tone: "negative" | "warning"; text: string; href: string }[];
  workQueueTitle: string;
  directoryTitle: string;
  attentionTitle: string;
  attentionAllClear: string;
  showPolicyNotice: boolean;
  stats: {
    openRequestsLabel: string;
    openRequestsValue: string;
    unscheduledVisitsLabel: string;
    unscheduledVisitsValue: string;
    todayVisitsLabel: string;
    todayVisitsValue: string;
    responseBreachesLabel: string;
    responseBreachesValue: string;
    readyToInvoiceLabel: string;
    readyToInvoiceValue: string;
  };
}

/** Built-in report slugs in the Reports hub, and their titles in the service catalog. */
export const SERVICE_REPORTS = [
  ["service-jobs-by-status", "service_jobs_by_status"],
  ["service-technician-utilization", "service_technician_utilization"],
  ["service-first-time-fix", "service_first_time_fix"],
  ["service-quote-win-rate", "service_quote_win_rate"],
  ["service-revenue-per-job", "service_revenue_per_job"],
] as const;

export async function loadServiceHome(
  sp: Record<string, string | string[] | undefined> = {},
): Promise<ServiceHomeData> {
  const { authz, capabilities } = await requireServiceArea();
  const actor = serviceActor(authz);
  const t = await getTranslations("service");
  const locale = await getLocale();
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  const canReadReports = can(authz, "reports.read");
  const [summary, boards, reportIds] = await Promise.all([
    serviceHomeSummary(actor),
    listBoards(actor, { generalOnly: true }),
    canReadReports
      ? Promise.all(
          SERVICE_REPORTS.map(([slug]) => builtInReportDefinitionId(authz.user.orgId, slug)),
        )
      : Promise.resolve(SERVICE_REPORTS.map(() => null)),
  ]);
  const reports = SERVICE_REPORTS.flatMap(([, key], index) =>
    reportIds[index]
      ? [{ href: `/reports/custom/run/${reportIds[index]}`, title: t(`reports.${key}`) }]
      : [],
  );
  const activeWork = sp.work === "requests" ? "requests" : "visits";
  const currentParams = { ...sp };
  delete currentParams.work;
  const tabs = serviceWorkspaceTabs("overview", {
    overview: t("tabs.overview"),
    requests: t("tabs.requests"),
    jobs: t("tabs.jobs"),
    visits: t("tabs.visits"),
    agreements: t("tabs.agreements"),
  });
  const workTabs = [
    { href: "/service?work=visits", label: t("tabs.visits"), active: activeWork === "visits" },
    {
      href: "/service?work=requests",
      label: t("tabs.requests"),
      active: activeWork === "requests",
    },
  ];
  const dispatchBoards = boards.filter((board) => boardHasCapability(board, "dispatch"));
  const directory: DirectoryItem[] = [
    {
      href: "/service/requests",
      label: t("tabs.requests"),
      iconKey: "inbox",
      badge: { value: count(summary.openRequests) },
    },
    {
      href: "/service/jobs",
      label: t("tabs.jobs"),
      iconKey: "wrench",
      badge: {
        value: count(summary.readyToInvoice),
        tone: summary.readyToInvoice > 0 ? "warning" : "neutral",
      },
    },
    {
      href: "/service/visits",
      label: t("tabs.visits"),
      iconKey: "calendar-check",
      badge: {
        value: count(summary.unscheduledVisits),
        tone: summary.unscheduledVisits > 0 ? "warning" : "neutral",
      },
    },
    {
      href: "/service/agreements",
      label: t("tabs.agreements"),
      iconKey: "rotate-ccw",
      badge: { value: count(summary.activeAgreements), tone: "positive" },
    },
    {
      href: "/scheduling",
      label: t("home.boards"),
      iconKey: "calendar-range",
      badge: { value: count(dispatchBoards.length) },
    },
    ...(canReadReports
      ? [
          {
            href: "/reports",
            label: t("home.reports"),
            iconKey: "chart-no-axes-combined",
            badge: { value: count(reports.length) },
          },
        ]
      : []),
    ...dispatchBoards.map((board) => ({
      href: `/scheduling?board=${encodeURIComponent(board.code)}&view=dispatch`,
      label: board.name,
      iconKey: "calendar-range",
    })),
    ...reports.map((report) => ({
      href: report.href,
      label: report.title,
      iconKey: "chart-no-axes-combined",
    })),
  ];
  const attention: ServiceHomeData["attention"] = [
    ...(summary.responseBreaches > 0
      ? [
          {
            tone: "negative" as const,
            text: t("home.attention.responseBreaches", { count: summary.responseBreaches }),
            href: "/service/visits",
          },
        ]
      : []),
    ...(summary.quotesAwaitingAnswer > 0
      ? [
          {
            tone: "warning" as const,
            text: t("home.attention.quotesAwaitingAnswer", { count: summary.quotesAwaitingAnswer }),
            href: "/service/requests?status=quoted",
          },
        ]
      : []),
    ...(summary.awaitingReview > 0
      ? [
          {
            tone: "warning" as const,
            text: t("home.attention.awaitingReview", { count: summary.awaitingReview }),
            href: "/inbox",
          },
        ]
      : []),
  ];
  return {
    title: t("pages.home.title"),
    description: t("pages.home.description"),
    summary,
    canConfigure: can(authz, "admin.setup.manage"),
    canCreate: capabilities.manage,
    newLabel: t("pages.requests.new"),
    tabs,
    workTabs,
    activeWork,
    currentParams,
    directory,
    attention,
    workQueueTitle: t("home.workQueue"),
    directoryTitle: t("home.directoryTitle"),
    attentionTitle: t("home.attentionTitle"),
    attentionAllClear: t("home.allClear"),
    showPolicyNotice: !summary.policyConfigured,
    stats: {
      openRequestsLabel: t("home.tiles.openRequests"),
      openRequestsValue: count(summary.openRequests),
      unscheduledVisitsLabel: t("home.tiles.unscheduledVisits"),
      unscheduledVisitsValue: count(summary.unscheduledVisits),
      todayVisitsLabel: `${t("home.tiles.todayVisits")} / ${t("home.tiles.inProgressVisits")}`,
      todayVisitsValue: `${count(summary.todayVisits)} / ${count(summary.inProgressVisits)}`,
      responseBreachesLabel: t("home.tiles.responseBreaches"),
      responseBreachesValue: count(summary.responseBreaches),
      readyToInvoiceLabel: t("home.tiles.readyToInvoice"),
      readyToInvoiceValue: count(summary.readyToInvoice),
    },
  };
}

const f = ref<ServiceHomeData>();

export function serviceHomeSpec(data: ServiceHomeData): PageSpec {
  return page({
    route: "/service",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget(
            "service-new-button",
            { kind: "request", label: data.newLabel, basePath: "/service/requests" },
            f("canCreate"),
          ),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock(
        "service-home",
        {
          summary: data.summary,
          canConfigure: data.canConfigure,
        },
        f("showPolicyNotice"),
      ),
      grid("flex h-full min-h-0 flex-col gap-4", [
        grid("grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5", [
          statTile({
            iconKey: "inbox",
            accent: "teal",
            label: f("stats.openRequestsLabel"),
            value: f("stats.openRequestsValue"),
          }),
          statTile({
            iconKey: "calendar-clock",
            accent: "amber",
            label: f("stats.unscheduledVisitsLabel"),
            value: f("stats.unscheduledVisitsValue"),
          }),
          statTile({
            iconKey: "calendar-check",
            accent: "sky",
            label: f("stats.todayVisitsLabel"),
            value: f("stats.todayVisitsValue"),
          }),
          statTile({
            iconKey: "triangle-alert",
            accent: "red",
            label: f("stats.responseBreachesLabel"),
            value: f("stats.responseBreachesValue"),
            tone: data.summary.responseBreaches > 0 ? "negative" : undefined,
          }),
          statTile({
            iconKey: "receipt",
            accent: "emerald",
            label: f("stats.readyToInvoiceLabel"),
            value: f("stats.readyToInvoiceValue"),
          }),
        ]),
        grid("grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3", [
          panel({
            title: f("workQueueTitle"),
            iconKey: "calendar-check",
            bodyClassName: "min-h-0 overflow-y-auto p-0",
            className: "min-h-0 lg:col-span-2",
            blocks: [
              widgetBlock("module-home-tabs", { tabs: data.workTabs, placement: "local" }),
              widgetBlock("entity-list-view", {
                recordType: data.activeWork === "requests" ? "service_request" : "service_visit",
                sp: data.currentParams,
                drawer: { widget: "service-record-host", props: {} },
              }),
            ],
          }),
          grid("flex min-h-0 flex-col gap-5 overflow-y-auto", [
            panel({
              title: f("attentionTitle"),
              iconKey: "triangle-alert",
              bodyClassName: "p-0",
              className: "shrink-0",
              blocks: [
                widgetBlock("attention-list", {
                  items: data.attention,
                  allClear: data.attentionAllClear,
                }),
              ],
            }),
            widgetBlock("directory-section", { items: data.directory, title: data.directoryTitle }),
          ]),
        ]),
      ]),
    ],
  });
}
