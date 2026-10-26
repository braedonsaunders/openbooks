import "server-only";
import {
  column,
  link,
  page,
  pageHeader,
  ref,
  text,
  widget,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import type { ListToolbarFilter } from "@/components/list-toolbar";
import type { ModuleHomeTab } from "@/components/module-home/tab-types";
import { registeredListTable } from "@/lib/list/prepared-spec";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { listManufacturingInspections } from "@openbooks/engine/manufacturing/quality-workspace";
import { manufacturingFeatureEnabled } from "@openbooks/engine/manufacturing/gate";
import { manufacturingOptions } from "@openbooks/engine/manufacturing/workspace";
import { lockManufacturingReadAuthority } from "@openbooks/engine/manufacturing/authority";
import { can, requirePermission } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { timeCommandGrants } from "@/lib/time-workspace";
import {
  manufacturingModuleTabs,
  type ManufacturingTabLabels,
} from "@/lib/module-home/manufacturing-tabs";
import { formatDecimal } from "@/lib/money-format";

export type ManufacturingQualityRow = {
  id: string;
  name: string;
  itemName: string;
  outcome: string;
  quantity: string;
  lotNumber: string;
  serialNumber: string;
  disposition: string;
  href: string;
};

export type ManufacturingQualityData = {
  title: string;
  description: string;
  plansLabel: string;
  plansHref: string;
  canManagePlans: boolean;
  tabs: ModuleHomeTab[];
  currentParams: Record<string, string | string[] | undefined>;
  basePath: string;
  filters: ListToolbarFilter[];
  searchPlaceholder: string;
  queue: { rows: ManufacturingQualityRow[]; total: number; page: number; perPage: number };
  emptyTitle: string;
  emptyDescription: string;
  columns: {
    name: string;
    item: string;
    outcome: string;
    quantity: string;
    lot: string;
    serial: string;
    disposition: string;
  };
};

export type ManufacturingQualityPageData = ManufacturingQualityData & {
  closeHref: string;
  selectedInspectionId: string | undefined;
  canInspect: boolean;
  canPost: boolean;
  scrapReasons: Awaited<ReturnType<typeof manufacturingOptions>>["reasons"];
};

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function loadManufacturingQuality(
  sp: Record<string, string | string[] | undefined>,
): Promise<ManufacturingQualityPageData> {
  return loadManufacturingQualityData(sp);
}

async function loadManufacturingQualityData(
  sp: Record<string, string | string[] | undefined>,
): Promise<ManufacturingQualityPageData> {
  const authz = await requirePermission("manufacturing.read");
  await requirePermission("items.read");
  await requireFeatureEnabled(authz.user.orgId, "manufacturing");
  const [t, mfg, nav, genealogyT, locale] = await Promise.all([
    getTranslations("manufacturing.quality"),
    getTranslations("manufacturing"),
    getTranslations("nav"),
    getTranslations("manufacturing.genealogy"),
    getLocale(),
  ]);
  const statusValues = ["pending", "pass", "fail"] as const;
  const rawStatus = first(sp.status);
  const status =
    rawStatus === "all"
      ? undefined
      : statusValues.includes(rawStatus as (typeof statusValues)[number])
        ? (rawStatus as (typeof statusValues)[number])
        : "pending";
  const workOrderId = uuidString().safeParse(first(sp.workOrderId));
  const rawSubsidiary = first(sp.sub) ?? first(sp.subsidiaryId);

  const loaded = await withScopeSnapshot(authz.user.orgId, async () => {
    const scope = await lockManufacturingReadAuthority(
      db,
      authz.user.orgId,
      authz.user.id,
      authz.allowedSubsidiaryIds,
      ["manufacturing.read", "items.read"],
    );
    const options = await manufacturingOptions(db, authz.user.orgId, scope, false, authz.user.id);
    const subsidiaryId = options.subsidiaries.some((option) => option.value === rawSubsidiary)
      ? rawSubsidiary
      : undefined;
    const queue = await listManufacturingInspections(db, authz.user.orgId, authz.user.id, {
      status,
      workOrderId: workOrderId.success ? workOrderId.data : undefined,
      subsidiaryId,
      q: first(sp.q)?.slice(0, 200),
      page: Number.parseInt(first(sp.page) ?? "1", 10) || 1,
    });
    return { queue, options, subsidiaryId };
  });

  const labels: ManufacturingTabLabels = {
    home: nav("manufacturing"),
    "work-orders": nav("manufacturing-work-orders"),
    "work-centers": nav("manufacturing-work-centers"),
    routings: nav("manufacturing-routings"),
    mrp: nav("manufacturing-mrp"),
    quality: t("title"),
    genealogy: genealogyT("title"),
    time: nav("manufacturing-time"),
  };
  const [mrpEnabled, timeGrants] = await Promise.all([
    manufacturingFeatureEnabled(authz.user.orgId, "manufacturingMrp"),
    Promise.resolve(timeCommandGrants("time.read")),
  ]);
  const tabs = manufacturingModuleTabs("quality", labels, {
    mrp: mrpEnabled,
    quality: true,
    genealogy: true,
    time: [...timeGrants.all, ...timeGrants.own].some((permission) => can(authz, permission)),
    subsidiaryId: loaded.subsidiaryId,
  });
  const currentParams = { ...sp, ...(loaded.subsidiaryId ? { sub: loaded.subsidiaryId } : {}) };
  const params = new URLSearchParams();
  for (const key of ["status", "workOrderId", "page", "q", "sub"]) {
    const value = first(sp[key]);
    if (value) params.set(key, value);
  }
  if (loaded.subsidiaryId) params.set("sub", loaded.subsidiaryId);
  const closeHref = "/manufacturing/quality" + (params.size ? `?${params}` : "");
  const selected = uuidString().safeParse(first(sp.inspection));
  const filters: ManufacturingQualityData["filters"] = [
    {
      paramKey: "status",
      label: t("outcome"),
      allLabel: mfg("allStatuses"),
      defaultValue: "pending",
      options: statusValues.map((value) => ({ value, label: t(`status.${value}`) })),
    },
    {
      paramKey: "sub",
      label: mfg("fields.subsidiaryId"),
      allLabel: mfg("allEntities"),
      options: loaded.options.subsidiaries.map((option) => ({
        value: option.value,
        label: option.label,
      })),
    },
  ];
  const data: ManufacturingQualityData = {
    title: t("title"),
    description: t("description"),
    plansLabel: t("plans"),
    plansHref: "/admin/setup/manufacturing?tab=inspection-plans",
    canManagePlans: can(authz, "admin.setup.manage") && authz.allowedSubsidiaryIds === null,
    tabs,
    currentParams,
    basePath: "/manufacturing/quality",
    filters,
    searchPlaceholder: mfg("searchPlaceholder"),
    queue: {
      ...loaded.queue,
      rows: loaded.queue.rows.map((inspection) => ({
        id: inspection.id,
        name: inspection.name,
        itemName: inspection.itemName,
        outcome: inspection.sourceActive ? t(`status.${inspection.status}`) : t("sourceReversed"),
        quantity: formatDecimal(locale, inspection.quantity, { maximumFractionDigits: 4 }),
        lotNumber: inspection.lotNumber ?? "—",
        serialNumber: inspection.serialNumber ?? "—",
        disposition: inspection.disposition ? t(`dispositions.${inspection.disposition}`) : "—",
        href:
          closeHref +
          (closeHref.includes("?") ? "&" : "?") +
          `inspection=${encodeURIComponent(inspection.id)}`,
      })),
    },
    emptyTitle: t("empty"),
    emptyDescription: t("emptyNote"),
    columns: {
      name: t("plan"),
      item: t("item"),
      outcome: t("outcome"),
      quantity: t("quantity"),
      lot: t("lot"),
      serial: t("serial"),
      disposition: t("disposition"),
    },
  };
  return {
    ...data,
    closeHref,
    selectedInspectionId: selected.success ? selected.data : undefined,
    canInspect: can(authz, "manufacturing.manage") && can(authz, "items.manage"),
    canPost: can(authz, "items.post"),
    scrapReasons: loaded.options.reasons.filter((option) => option.parentId === "normal"),
  };
}

const f = ref<ManufacturingQualityData>();
const row = ref<ManufacturingQualityRow>();

export function manufacturingQualitySpec(_data: ManufacturingQualityData): PageSpec {
  return page({
    route: "/manufacturing/quality",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actionsClassName: "flex flex-wrap items-center gap-2",
        actions: [
          widget("module-home-tabs", { tabs: f("tabs") }),
          widget(
            "link-button",
            {
              href: f("plansHref"),
              label: f("plansLabel"),
              variant: "outline",
            },
            f("canManagePlans"),
          ),
        ],
      }),
    ],
    body: [
      registeredListTable(
        "manufacturing_quality",
        {
          variant: "app",
          rows: f("queue.rows"),
          rowKey: row("id"),
          empty: { title: f("emptyTitle"), description: f("emptyDescription") },
          columns: [
            column(f("columns.name"), link(row("name"), row("href")), { className: "font-medium" }),
            column(f("columns.item"), text(row("itemName"))),
            column(f("columns.outcome"), text(row("outcome"))),
            column(f("columns.quantity"), text(row("quantity"))),
            column(f("columns.lot"), text(row("lotNumber"))),
            column(f("columns.serial"), text(row("serialNumber"))),
            column(f("columns.disposition"), text(row("disposition"))),
          ],
        },
        [
          widget("list-toolbar", {
            basePath: f("basePath"),
            currentParams: f("currentParams"),
            search: { placeholder: f("searchPlaceholder") },
            filters: f("filters"),
          }),
        ],
      ),
    ],
  });
}
