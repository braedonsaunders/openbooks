import "server-only";
import {
  column,
  grid,
  link,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import type { DirectoryItem } from "@/components/module-home/ui";
import type { ListToolbarFilter } from "@/components/list-toolbar";
import type { ModuleHomeTab } from "@/components/module-home/tab-types";
import { registeredListTable } from "@/lib/list/prepared-spec";
import { readWorkListFilters } from "@openbooks/engine/organization/work-list-filters";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { manufacturingFeatureEnabled } from "@openbooks/engine/manufacturing/gate";
import { lockManufacturingReadAuthority } from "@openbooks/engine/manufacturing/authority";
import { countManufacturingGenealogySeeds } from "@openbooks/engine/manufacturing/genealogy";
import { listManufacturingInspections } from "@openbooks/engine/manufacturing/quality-workspace";
import {
  listManufacturingRecords,
  manufacturingOptions,
  readManufacturingHomeSummary,
} from "@openbooks/engine/manufacturing/workspace";
import { listOperatingProfileChoices } from "@openbooks/engine/organization/operating-profiles";
import { db } from "@openbooks/engine/platform/db";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { z } from "zod";
import { getLocale, getTranslations } from "next-intl/server";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { timeCommandGrants } from "@/lib/time-workspace";
import {
  manufacturingModuleTabs,
  type ManufacturingTabLabels,
} from "@/lib/module-home/manufacturing-tabs";
import { formatDecimal } from "@/lib/money-format";
import { formatCount } from "@/lib/format";

export type ManufacturingHomeRow = {
  id: string;
  number: string;
  itemName: string;
  statusLabel: string;
  quantityCompleted: string;
  quantityOrdered: string;
  unit: string;
  href: string;
};

export type ManufacturingHomeData = {
  title: string;
  description: string;
  labels: {
    open: string;
    inProgress: string;
    pendingQuality: string;
    attention: string;
    completedSevenDays: string;
    hero: string;
    directory: string;
    attentionTitle: string;
    allClear: string;
    newWorkOrder: string;
    search: string;
  };
  columns: { number: string; item: string; status: string; finished: string; ordered: string };
  metrics: {
    openWorkOrders: string;
    inProgressWorkOrders: string;
    pendingInspections: string;
    pastDueOrOnHoldWorkOrders: string;
    completedLastSevenDays: string;
  };
  orders: { rows: ManufacturingHomeRow[]; total: number; page: number; perPage: number };
  tabs: ModuleHomeTab[];
  subsidiaryPicker: { id: string; label: string }[];
  subsidiaryId: string;
  subsidiaryLabel: string;
  canCreate: boolean;
  newWorkOrderHref: string;
  currentParams: Record<string, string | string[] | undefined>;
  filters: ListToolbarFilter[];
  directory: DirectoryItem[];
  attention: { tone: "negative" | "warning"; text: string; href: string }[];
};

export type ManufacturingHomePageData = ManufacturingHomeData & {
  legacyMode: "setup" | "start" | undefined;
  canSetup: boolean;
  allLabels: string;
  closeHref: string;
  selectedRecordId: string | undefined;
  legacyTabs: ModuleHomeTab[];
  legacyText: { firstTime: string; setup: string; projectNote: string };
  recordHost: {
    options: Awaited<ReturnType<typeof manufacturingOptions>>;
    operatingChoices: Awaited<ReturnType<typeof listOperatingProfileChoices>>;
    canManage: boolean;
    canPost: boolean;
    canBuy: boolean;
    canSubcontract: boolean;
    canReadQuality: boolean;
    canReadJournal: boolean;
    canGovernRevisions: boolean;
  };
};

const f = ref<ManufacturingHomeData>();
const row = ref<ManufacturingHomeRow>();
const scalar = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const routeStatus = z.enum([
  "open",
  "all",
  "draft",
  "released",
  "in_progress",
  "on_hold",
  "done",
  "cancelled",
]);

type SearchParams = Record<string, string | string[] | undefined>;
type Authz = Awaited<ReturnType<typeof requirePermission>>;

async function accessTabs(
  authz: Authz,
  selectedSubsidiaryId: string | undefined,
  labels: ManufacturingTabLabels,
) {
  const [mrp, items, productionTimeGrants] = await Promise.all([
    manufacturingFeatureEnabled(authz.user.orgId, "manufacturingMrp"),
    Promise.resolve(can(authz, "items.read")),
    Promise.resolve(timeCommandGrants("time.read")),
  ]);
  const time = [...productionTimeGrants.all, ...productionTimeGrants.own].some((permission) =>
    can(authz, permission),
  );
  return manufacturingModuleTabs("home", labels, {
    mrp,
    quality: items,
    genealogy: items,
    time,
    subsidiaryId: selectedSubsidiaryId,
  });
}

export function loadManufacturingHome(
  sp: Record<string, string | string[] | undefined>,
): Promise<ManufacturingHomePageData> {
  return loadManufacturingHomeData(sp);
}

async function loadManufacturingHomeData(sp: SearchParams): Promise<ManufacturingHomePageData> {
  const authz = await requirePermission("manufacturing.read");
  await requireFeatureEnabled(authz.user.orgId, "manufacturing");
  const [t, nav, genealogyT, operatingProfiles, home, agents, locale] = await Promise.all([
    getTranslations("manufacturing"),
    getTranslations("nav"),
    getTranslations("manufacturing.genealogy"),
    getTranslations("operatingProfiles"),
    getTranslations("home"),
    getTranslations("agents"),
    getLocale(),
  ]);
  const labels: ManufacturingTabLabels = {
    home: nav("manufacturing"),
    "work-orders": nav("manufacturing-work-orders"),
    "work-centers": nav("manufacturing-work-centers"),
    routings: nav("manufacturing-routings"),
    mrp: nav("manufacturing-mrp"),
    quality: nav("manufacturing-quality"),
    genealogy: genealogyT("title"),
    time: nav("manufacturing-time"),
  };
  const allTabs = await accessTabs(authz, undefined, labels);
  const view = scalar(sp.view);
  const canSetup = can(authz, "admin.setup.manage") && authz.allowedSubsidiaryIds === null;
  const legacyMode =
    view === "setup" && canSetup
      ? "setup"
      : view === "start" && can(authz, "manufacturing.manage")
        ? "start"
        : undefined;

  const statusValue = routeStatus.safeParse(scalar(sp.status) ?? "open");
  const status = statusValue.success ? statusValue.data : "open";
  const rawSubsidiary = scalar(sp.sub);

  const loaded = await withScopeSnapshot(authz.user.orgId, async () => {
    const scope = await lockManufacturingReadAuthority(
      db,
      authz.user.orgId,
      authz.user.id,
      authz.allowedSubsidiaryIds,
    );
    const options = await manufacturingOptions(
      db,
      authz.user.orgId,
      scope,
      can(authz, "ap.create"),
      authz.user.id,
    );
    const subsidiaryId = options.subsidiaries.some((option) => option.value === rawSubsidiary)
      ? rawSubsidiary
      : undefined;
    const queryStatus = status === "open" || status === "all" ? undefined : status;
    const [
      summary,
      orders,
      onHoldOrders,
      centers,
      routings,
      pending,
      failed,
      draftRoutings,
      mrpRuns,
      genealogyCount,
      workFilters,
      operatingChoices,
    ] = await Promise.all([
      readManufacturingHomeSummary(db, authz.user.orgId, authz.user.id, scope, {
        subsidiaryId,
        today: await businessToday(authz.user.orgId),
      }),
      listManufacturingRecords(
        db,
        authz.user.orgId,
        scope,
        "work-orders",
        {
          page: Number.parseInt(scalar(sp.page) ?? "1", 10) || 1,
          perPage: 25,
          activeOnly: status === "open",
          status: queryStatus,
          q: scalar(sp.q),
          subsidiaryId,
          workflow: scalar(sp.workflowFilter),
          department: scalar(sp.department),
        },
        authz.user.id,
      ),
      listManufacturingRecords(
        db,
        authz.user.orgId,
        scope,
        "work-orders",
        { page: 1, perPage: 4, status: "on_hold", subsidiaryId },
        authz.user.id,
      ),
      listManufacturingRecords(
        db,
        authz.user.orgId,
        scope,
        "work-centers",
        { page: 1, perPage: 10, subsidiaryId },
        authz.user.id,
      ),
      listManufacturingRecords(
        db,
        authz.user.orgId,
        scope,
        "routings",
        { page: 1, perPage: 10, subsidiaryId },
        authz.user.id,
      ),
      can(authz, "items.read")
        ? listManufacturingInspections(db, authz.user.orgId, authz.user.id, {
            status: "pending",
            subsidiaryId,
          })
        : null,
      can(authz, "items.read")
        ? listManufacturingInspections(db, authz.user.orgId, authz.user.id, {
            status: "fail",
            subsidiaryId,
          })
        : null,
      listManufacturingRecords(
        db,
        authz.user.orgId,
        scope,
        "routings",
        { page: 1, perPage: 4, status: "draft", subsidiaryId },
        authz.user.id,
      ),
      (await manufacturingFeatureEnabled(authz.user.orgId, "manufacturingMrp"))
        ? listManufacturingRecords(
            db,
            authz.user.orgId,
            scope,
            "mrp",
            { page: 1, perPage: 10, subsidiaryId },
            authz.user.id,
          )
        : null,
      can(authz, "items.read")
        ? countManufacturingGenealogySeeds(db, authz.user.orgId, authz.user.id, scope)
        : null,
      readWorkListFilters(db, authz.user.orgId, authz.user.id, "production"),
      listOperatingProfileChoices(db, authz.user.orgId, authz.user.id, "production"),
    ]);
    return {
      scope,
      options,
      subsidiaryId,
      summary,
      orders,
      onHoldOrders,
      centers,
      routings,
      pending,
      failed,
      draftRoutings,
      mrpRuns,
      genealogyCount,
      workFilters,
      operatingChoices,
    };
  });

  const selectedSubsidiaryId = loaded.subsidiaryId;
  const scopedHref = (path: string, values?: Record<string, string>) => {
    const next = new URLSearchParams();
    if (selectedSubsidiaryId) next.set("sub", selectedSubsidiaryId);
    for (const [key, value] of Object.entries(values ?? {})) next.set(key, value);
    return path + (next.size ? `?${next}` : "");
  };
  const newOrderParams = new URLSearchParams();
  if (selectedSubsidiaryId) newOrderParams.set("sub", selectedSubsidiaryId);
  newOrderParams.set("record", "new");
  const newWorkOrderHref = `/manufacturing/work-orders?${newOrderParams}`;
  const tabs = manufacturingModuleTabs("home", labels, {
    mrp: loaded.mrpRuns !== null,
    quality: can(authz, "items.read"),
    genealogy: can(authz, "items.read"),
    time: allTabs.some((tab) => tab.href.startsWith("/manufacturing/time")),
    subsidiaryId: selectedSubsidiaryId,
  });
  const paramsWithoutRecord = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (!["record", "sub", "subsidiaryId"].includes(key) && typeof value === "string")
      paramsWithoutRecord.set(key, value);
  }
  if (selectedSubsidiaryId) paramsWithoutRecord.set("sub", selectedSubsidiaryId);
  const closeHref = "/manufacturing" + (paramsWithoutRecord.size ? `?${paramsWithoutRecord}` : "");
  const selectedRecord = uuidString().safeParse(scalar(sp.record));

  const allLabels = t("allEntities");
  const toolbarFilters: ListToolbarFilter[] = [
    {
      paramKey: "status",
      label: t("fields.status"),
      allLabel: t("allStatuses"),
      defaultValue: "open",
      options: [
        { value: "open", label: t("cockpit.open") },
        ...(["draft", "released", "in_progress", "on_hold", "done", "cancelled"] as const).map(
          (value) => ({ value, label: t(`values.${value}`) }),
        ),
      ],
    },
    {
      paramKey: "sub",
      label: t("fields.subsidiaryId"),
      allLabel: allLabels,
      options: loaded.options.subsidiaries.map((option) => ({
        value: option.value,
        label: option.label,
      })),
    },
    {
      paramKey: "workflowFilter",
      label: operatingProfiles("filters.workflow"),
      allLabel: operatingProfiles("filters.allWorkflows"),
      options: [
        { value: "legacy", label: operatingProfiles("filters.legacy") },
        ...loaded.workFilters.profiles.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      ],
    },
    {
      paramKey: "department",
      label: operatingProfiles("filters.department"),
      allLabel: operatingProfiles("filters.allDepartments"),
      options: [
        { value: "unassigned", label: operatingProfiles("filters.unassigned") },
        ...loaded.workFilters.departments.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      ],
    },
  ];
  const directory: ManufacturingHomeData["directory"] = [
    {
      href: scopedHref("/manufacturing/work-orders"),
      label: nav("manufacturing-work-orders"),
      iconKey: "clipboard",
      badge: {
        value: formatCount(loaded.summary.openWorkOrders, locale),
        hint: t("cockpit.open"),
        tone: loaded.summary.openWorkOrders ? "warning" : "positive",
      },
    },
    {
      href: scopedHref("/manufacturing/work-centers"),
      label: nav("manufacturing-work-centers"),
      iconKey: "factory",
      badge: { value: formatCount(loaded.centers.total, locale) },
    },
    {
      href: scopedHref("/manufacturing/routings"),
      label: nav("manufacturing-routings"),
      iconKey: "workflow",
      badge: { value: formatCount(loaded.routings.total, locale) },
    },
  ];
  if (loaded.mrpRuns)
    directory.push({
      href: scopedHref("/manufacturing/mrp"),
      label: nav("manufacturing-mrp"),
      iconKey: "chart-no-axes-combined",
      badge: { value: formatCount(loaded.mrpRuns.total, locale) },
    });
  if (loaded.pending)
    directory.push({
      href: scopedHref("/manufacturing/quality"),
      label: nav("manufacturing-quality"),
      iconKey: "shield",
      badge: {
        value: formatCount(loaded.pending.total, locale),
        hint: t("quality.status.pending"),
        tone: loaded.pending.total ? "warning" : "positive",
      },
    });
  if (loaded.genealogyCount !== null)
    directory.push({
      href: scopedHref("/manufacturing/genealogy"),
      label: genealogyT("title"),
      iconKey: "git-branch",
      badge: { value: formatCount(loaded.genealogyCount, locale) },
    });

  const attention: ManufacturingHomeData["attention"] = [];
  for (const order of loaded.onHoldOrders.rows) {
    attention.push({
      tone: "negative",
      text: `${t("fields.number")} ${String(order.number)} · ${t("values.on_hold")}`,
      href: scopedHref("/manufacturing/work-orders", { record: order.id }),
    });
  }
  for (const inspection of (loaded.failed?.rows ?? [])
    .filter((candidate) => candidate.sourceActive && !candidate.disposition)
    .slice(0, 3)) {
    attention.push({
      tone: "negative",
      text: `${t("quality.status.fail")} · ${inspection.name} · ${inspection.itemName}`,
      href: scopedHref("/manufacturing/quality", { inspection: inspection.id }),
    });
  }
  for (const routing of loaded.draftRoutings.rows.slice(0, 3)) {
    attention.push({
      tone: "warning",
      text: `${t("values.draft")} · ${String(routing.code)} · ${String(routing.name)}`,
      href: scopedHref("/manufacturing/routings", { record: routing.id }),
    });
  }

  const legacyTabs: ModuleHomeTab[] = tabs.map((tab) => ({
    ...tab,
    active: tab.href.startsWith("/manufacturing?") || tab.href === "/manufacturing",
  }));
  const canManage = can(authz, "manufacturing.manage");
  const data: ManufacturingHomePageData = {
    title: t("title"),
    description: t("cockpit.description"),
    labels: {
      open: t("cockpit.open"),
      inProgress: t("values.in_progress"),
      pendingQuality: t("quality.status.pending"),
      attention: home("sections.attention"),
      completedSevenDays: `${t("values.done")} · ${agents("week")}`,
      hero: t("cockpit.work"),
      directory: t("homeTitle"),
      attentionTitle: t("setupJourney.states.missing"),
      allClear: home("empty.attention"),
      newWorkOrder: t("new.work-orders"),
      search: t("searchPlaceholder"),
    },
    columns: {
      number: t("fields.number"),
      item: t("fields.itemName"),
      status: t("fields.status"),
      finished: t("fields.quantityCompleted"),
      ordered: t("fields.quantityOrdered"),
    },
    metrics: {
      openWorkOrders: formatCount(loaded.summary.openWorkOrders, locale),
      inProgressWorkOrders: formatCount(loaded.summary.inProgressWorkOrders, locale),
      pendingInspections: formatCount(loaded.pending?.total ?? 0, locale),
      pastDueOrOnHoldWorkOrders: formatCount(loaded.summary.pastDueOrOnHoldWorkOrders, locale),
      completedLastSevenDays: formatCount(loaded.summary.completedLastSevenDays, locale),
    },
    orders: {
      ...loaded.orders,
      rows: loaded.orders.rows.map((order) => ({
        id: order.id,
        number: String(order.number),
        itemName: String(order.itemName),
        statusLabel: t(`values.${String(order.status)}`),
        quantityCompleted: formatDecimal(locale, String(order.quantityCompleted), {
          maximumFractionDigits: 4,
        }),
        quantityOrdered: formatDecimal(locale, String(order.quantityOrdered), {
          maximumFractionDigits: 4,
        }),
        unit: String(order.unit),
        href: scopedHref("/manufacturing/work-orders", { record: order.id }),
      })),
    },
    tabs,
    subsidiaryPicker:
      loaded.options.subsidiaries.length > 1
        ? [
            { id: "", label: allLabels },
            ...loaded.options.subsidiaries.map((option) => ({
              id: option.value,
              label: option.label,
            })),
          ]
        : [],
    subsidiaryId: selectedSubsidiaryId ?? "",
    subsidiaryLabel: t("fields.subsidiaryId"),
    canCreate: canManage,
    newWorkOrderHref,
    currentParams: { ...sp, sub: selectedSubsidiaryId, subsidiaryId: undefined },
    filters: toolbarFilters,
    directory,
    attention: attention.slice(0, 8),
    legacyMode,
    canSetup,
    allLabels,
    closeHref,
    selectedRecordId: selectedRecord.success ? selectedRecord.data : undefined,
    legacyTabs,
    legacyText: {
      firstTime: t("cockpit.firstTime"),
      setup: t("cockpit.setup"),
      projectNote: t("cockpit.projectNote"),
    },
    recordHost: {
      options: loaded.options,
      operatingChoices: loaded.operatingChoices,
      canManage,
      canPost: can(authz, "items.post"),
      canBuy: can(authz, "purchase_orders.create"),
      canSubcontract: await manufacturingFeatureEnabled(
        authz.user.orgId,
        "manufacturingSubcontract",
      ),
      canReadQuality: can(authz, "items.read"),
      canReadJournal: can(authz, "gl.read"),
      canGovernRevisions: canManage && authz.allowedSubsidiaryIds === null,
    },
  };
  return data;
}

export function manufacturingHomeSpec(_data: ManufacturingHomeData): PageSpec {
  return page({
    route: "/manufacturing",
    layout: "list",
    bodyClassName: "flex h-full min-h-0 flex-col",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center gap-2",
        actions: [
          widget("subsidiary-switcher", {
            picker: f("subsidiaryPicker"),
            value: f("subsidiaryId"),
            label: f("subsidiaryLabel"),
          }),
          widget("module-home-tabs", { tabs: f("tabs") }),
          widget(
            "link-button",
            {
              href: f("newWorkOrderHref"),
              label: f("labels.newWorkOrder"),
              iconKey: "plus",
            },
            f("canCreate"),
          ),
        ],
      }),
    ],
    body: [
      grid("flex h-full min-h-0 flex-col gap-4", [
        grid("grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5", [
          statTile({
            iconKey: "clipboard",
            accent: "teal",
            label: f("labels.open"),
            value: f("metrics.openWorkOrders"),
          }),
          statTile({
            iconKey: "timer",
            accent: "sky",
            label: f("labels.inProgress"),
            value: f("metrics.inProgressWorkOrders"),
          }),
          statTile({
            iconKey: "shield-check",
            accent: "amber",
            label: f("labels.pendingQuality"),
            value: f("metrics.pendingInspections"),
          }),
          statTile({
            iconKey: "triangle-alert",
            accent: "red",
            label: f("labels.attention"),
            value: f("metrics.pastDueOrOnHoldWorkOrders"),
            tone: "negative",
          }),
          statTile({
            iconKey: "check-circle",
            accent: "emerald",
            label: f("labels.completedSevenDays"),
            value: f("metrics.completedLastSevenDays"),
            tone: "positive",
          }),
        ]),
        grid("grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3", [
          panel({
            title: f("labels.hero"),
            iconKey: "clipboard",
            className: "min-h-0 lg:col-span-2",
            bodyClassName: "min-h-0 overflow-y-auto p-0",
            blocks: [
              registeredListTable(
                "manufacturing_home_queue",
                {
                  variant: "app",
                  rows: f("orders.rows"),
                  rowKey: row("id"),
                  empty: { title: f("labels.hero"), description: f("description") },
                  columns: [
                    column(f("columns.number"), link(row("number"), row("href")), {
                      className: "font-medium",
                    }),
                    column(f("columns.item"), text(row("itemName"))),
                    column(f("columns.status"), text(row("statusLabel"))),
                    column(f("columns.finished"), text(row("quantityCompleted"))),
                    column(f("columns.ordered"), text(row("quantityOrdered"))),
                  ],
                },
                [
                  widget("list-toolbar", {
                    basePath: "/manufacturing",
                    currentParams: f("currentParams"),
                    search: { placeholder: f("labels.search") },
                    filters: f("filters"),
                  }),
                ],
              ),
            ],
          }),
          grid("flex min-h-0 flex-col gap-5 overflow-y-auto", [
            widgetBlock("directory-section", {
              items: f("directory"),
              title: f("labels.directory"),
            }),
            panel({
              title: f("labels.attentionTitle"),
              iconKey: "alert",
              className: "shrink-0",
              bodyClassName: "p-0",
              blocks: [
                widgetBlock("attention-list", {
                  items: f("attention"),
                  allClear: f("labels.allClear"),
                }),
              ],
            }),
          ]),
        ]),
      ]),
    ],
  });
}
