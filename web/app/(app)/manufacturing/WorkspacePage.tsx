import { readWorkListFilters } from "@openbooks/engine/organization/work-list-filters";
import { listOperatingProfileChoices } from "@openbooks/engine/organization/operating-profiles";
import { manufacturingFeatureEnabled } from "@openbooks/engine/manufacturing/gate";
import {
  listManufacturingRecords,
  manufacturingOptions,
  searchManufacturingChoices,
  type ManufacturingRow,
  type ManufacturingView,
} from "@openbooks/engine/manufacturing/workspace";
import { requirePermission, can } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import { timeCommandGrants } from "@/lib/time-workspace";
import { formatDecimal } from "@/lib/money-format";
import { formatCivilDate, dateTime } from "@/lib/format";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { getLocale, getTranslations } from "next-intl/server";
import { db } from "@openbooks/engine/platform/db";
import { withScopeSnapshot } from "@openbooks/engine/organization/scope";
import { ModuleView } from "@/components/viewspec/module-view";
import {
  manufacturingModuleTabs,
  type ManufacturingTabLabels,
} from "@/lib/module-home/manufacturing-tabs";
import type { ListToolbarFilter } from "@/components/list-toolbar";
import {
  manufacturingWorkspaceSpec,
  type ManufacturingWorkspaceData,
  type ManufacturingWorkspaceRow,
} from "./workspace-view";
import { ManufacturingRecordHost } from "./RecordHost";

export type SearchParams = Record<string, string | string[] | undefined>;
const value = (input: string | string[] | undefined) => (Array.isArray(input) ? input[0] : input);
const uuid = (input: unknown) => {
  const parsed = uuidString().safeParse(input);
  return parsed.success ? parsed.data : undefined;
};

const fields: Record<ManufacturingView, { key: string; label: string; linked?: boolean }[]> = {
  "work-orders": [
    { key: "number", label: "number", linked: true },
    { key: "itemName", label: "itemName" },
    { key: "status", label: "status" },
    { key: "priority", label: "priority" },
    { key: "quantityOrdered", label: "quantityOrdered" },
    { key: "quantityCompleted", label: "quantityCompleted" },
    { key: "plannedStart", label: "plannedStart" },
    { key: "plannedEnd", label: "plannedEnd" },
  ],
  "work-centers": [
    { key: "code", label: "code", linked: true },
    { key: "name", label: "name" },
    { key: "kind", label: "kind" },
    { key: "status", label: "status" },
    { key: "capacityHoursPerDay", label: "capacityHoursPerDay" },
    { key: "efficiencyPct", label: "efficiencyPct" },
  ],
  routings: [
    { key: "code", label: "code", linked: true },
    { key: "name", label: "name" },
    { key: "itemName", label: "itemName" },
    { key: "version", label: "version" },
    { key: "status", label: "status" },
    { key: "effectiveFrom", label: "effectiveFrom" },
    { key: "effectiveTo", label: "effectiveTo" },
  ],
  mrp: [
    { key: "number", label: "number", linked: true },
    { key: "status", label: "status" },
    { key: "horizonStart", label: "horizonStart" },
    { key: "horizonEnd", label: "horizonEnd" },
    { key: "ranAt", label: "ranAt" },
  ],
};

const statuses: Record<ManufacturingView, string[]> = {
  "work-orders": ["draft", "released", "in_progress", "on_hold", "done", "cancelled"],
  "work-centers": ["active", "inactive"],
  routings: ["draft", "active", "archived"],
  mrp: ["draft", "complete", "superseded"],
};

export async function ManufacturingWorkspacePage({
  view,
  searchParams,
}: {
  view: ManufacturingView;
  searchParams: SearchParams;
}) {
  const authz = await requirePermission("manufacturing.read");
  await requireFeatureEnabled(
    authz.user.orgId,
    view === "mrp" ? "manufacturingMrp" : "manufacturing",
  );
  const [t, tNav, genealogyT, tOperating, locale] = await Promise.all([
    getTranslations("manufacturing"),
    getTranslations("nav"),
    getTranslations("manufacturing.genealogy"),
    getTranslations("operatingProfiles"),
    getLocale(),
  ]);
  const basePath = `/manufacturing/${view}`;
  const rawSub = value(searchParams.sub) ?? value(searchParams.subsidiaryId);
  const rawStatus = value(searchParams.status);
  const status = statuses[view].includes(rawStatus ?? "") ? rawStatus : undefined;
  const query = {
    q: value(searchParams.q)?.slice(0, 200),
    workflow: value(searchParams.workflowFilter),
    department: value(searchParams.department),
    status,
    subsidiaryId: uuid(rawSub),
    page: Math.max(1, Number.parseInt(value(searchParams.page) ?? "1", 10) || 1),
    perPage: Math.min(
      100,
      Math.max(10, Number.parseInt(value(searchParams.perPage) ?? "25", 10) || 25),
    ),
  };
  const canGovernRevisions =
    can(authz, "manufacturing.manage") && authz.allowedSubsidiaryIds === null;
  const loaded = await withScopeSnapshot(authz.user.orgId, async () => {
    const options = await manufacturingOptions(
      db,
      authz.user.orgId,
      authz.allowedSubsidiaryIds,
      can(authz, "ap.create"),
      authz.user.id,
    );
    const selectedSubsidiaryId = options.subsidiaries.some(
      (option) => option.value === query.subsidiaryId,
    )
      ? query.subsidiaryId
      : undefined;
    const [workFilters, page, operatingChoices] = await Promise.all([
      view === "work-orders"
        ? readWorkListFilters(db, authz.user.orgId, authz.user.id, "production")
        : null,
      listManufacturingRecords(
        db,
        authz.user.orgId,
        authz.allowedSubsidiaryIds,
        view,
        { ...query, subsidiaryId: selectedSubsidiaryId },
        authz.user.id,
      ),
      view === "work-orders"
        ? listOperatingProfileChoices(
            db,
            authz.user.orgId,
            authz.user.id,
            "production",
            uuid(value(searchParams.departmentId)) ?? null,
          )
        : [],
    ]);
    return {
      workFilters,
      page,
      operatingChoices,
      options,
      selectedSubsidiaryId,
    };
  });
  const selectedSubsidiaryId = loaded.selectedSubsidiaryId;
  const selectedItemId = uuid(value(searchParams.producedItemId));
  let initialItemId: string | undefined;
  if (view === "work-orders" && selectedItemId) {
    const matches = await withScopeSnapshot(authz.user.orgId, () =>
      searchManufacturingChoices(
        db,
        authz.user.orgId,
        authz.allowedSubsidiaryIds,
        "items",
        "",
        selectedItemId,
      ),
    );
    if (matches.some((item) => item.value === selectedItemId)) {
      initialItemId = selectedItemId;
      if (!loaded.options.items.some((item) => item.value === selectedItemId))
        loaded.options.items.push(matches.find((item) => item.value === selectedItemId)!);
    }
  }
  const params = new URLSearchParams();
  for (const [key, item] of Object.entries(searchParams))
    if (!["record", "sub", "subsidiaryId"].includes(key) && typeof item === "string")
      params.set(key, item);
  if (selectedSubsidiaryId) params.set("sub", selectedSubsidiaryId);
  const closeHref = basePath + (params.size ? `?${params}` : "");
  const newParams = new URLSearchParams(params);
  newParams.set("record", "new");
  const recordId = value(searchParams.record);
  const validRecord =
    recordId === "new" ? (can(authz, "manufacturing.manage") ? "new" : undefined) : uuid(recordId);

  const tabLabels: ManufacturingTabLabels = {
    home: tNav("manufacturing"),
    "work-orders": tNav("manufacturing-work-orders"),
    "work-centers": tNav("manufacturing-work-centers"),
    routings: tNav("manufacturing-routings"),
    mrp: tNav("manufacturing-mrp"),
    quality: tNav("manufacturing-quality"),
    genealogy: genealogyT("title"),
    time: tNav("manufacturing-time"),
  };
  const mrpEnabled = await manufacturingFeatureEnabled(authz.user.orgId, "manufacturingMrp");
  const timeGrants = timeCommandGrants("time.read");
  const tabs = manufacturingModuleTabs(view, tabLabels, {
    mrp: mrpEnabled,
    quality: can(authz, "items.read"),
    genealogy: can(authz, "items.read"),
    time: [...timeGrants.all, ...timeGrants.own].some((permission) => can(authz, permission)),
    subsidiaryId: selectedSubsidiaryId,
  });

  const filters: ListToolbarFilter[] = [
    {
      paramKey: "status",
      label: t("fields.status"),
      allLabel: t("allStatuses"),
      options: statuses[view].map((value) => ({
        value,
        label: t.has(`values.${value}`) ? t(`values.${value}`) : value,
      })),
    },
    {
      paramKey: "sub",
      label: t("fields.subsidiaryId"),
      allLabel: t("allEntities"),
      options: loaded.options.subsidiaries.map((option) => ({
        value: option.value,
        label: option.label,
      })),
    },
  ];
  if (view === "work-orders" && loaded.workFilters) {
    filters.push({
      paramKey: "workflowFilter",
      label: tOperating("filters.workflow"),
      allLabel: tOperating("filters.allWorkflows"),
      options: [
        { value: "legacy", label: tOperating("filters.legacy") },
        ...loaded.workFilters.profiles.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      ],
    });
    filters.push({
      paramKey: "department",
      label: tOperating("filters.department"),
      allLabel: tOperating("filters.allDepartments"),
      options: [
        { value: "unassigned", label: tOperating("filters.unassigned") },
        ...loaded.workFilters.departments.map((option) => ({
          value: option.value,
          label: option.label,
        })),
      ],
    });
  }

  const labelValue = (key: string, value: unknown) => {
    if (value === null || value === undefined || value === "") return "—";
    const raw = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return formatCivilDate(raw, locale);
    if (key.endsWith("At") && typeof value === "string") return dateTime(value, locale);
    if (/(quantity|Hours|Pct)/i.test(key) && typeof value === "string")
      return formatDecimal(locale, value, { maximumFractionDigits: 4 });
    return t.has(`values.${raw}`) ? t(`values.${raw}`) : raw;
  };
  const rows: ManufacturingWorkspaceRow[] = loaded.page.rows.map((record: ManufacturingRow) => {
    const row: ManufacturingWorkspaceRow = { id: record.id, href: "" };
    for (const field of fields[view]) row[field.key] = labelValue(field.key, record[field.key]);
    const rowParams = new URLSearchParams(params);
    rowParams.set("record", record.id);
    row.href = `${basePath}?${rowParams}`;
    return row;
  });
  const data: ManufacturingWorkspaceData = {
    view,
    title: t(`titles.${view}`),
    description: t(`descriptions.${view}`),
    emptyTitle: t(`empty.${view}`),
    emptyDescription: t(`emptyNote.${view}`),
    newLabel: t(`new.${view}`),
    newRecordHref: `${basePath}?${newParams}`,
    canCreate: can(authz, "manufacturing.manage"),
    basePath,
    currentParams: {
      ...searchParams,
      sub: selectedSubsidiaryId,
      subsidiaryId: undefined,
    },
    rows,
    total: loaded.page.total,
    page: loaded.page.page,
    perPage: loaded.page.perPage,
    tabs,
    columns: fields[view],
    searchPlaceholder: t("searchPlaceholder"),
    filters,
  };

  return (
    <>
      <ModuleView
        spec={manufacturingWorkspaceSpec(data)}
        data={data}
        searchParams={searchParams}
        trusted
      />
      <ManufacturingRecordHost
        view={view}
        recordId={validRecord}
        closeHref={closeHref}
        options={loaded.options}
        initialWorkflow={loaded.operatingChoices.find(
          (choice) => choice.value === value(searchParams.workflowFilter),
        )}
        initialDepartmentId={uuid(value(searchParams.departmentId))}
        initialValues={{
          producedItemId: initialItemId,
          subsidiaryId: selectedSubsidiaryId,
          quantityOrdered: value(searchParams.quantityOrdered),
        }}
        canManage={can(authz, "manufacturing.manage")}
        canPost={can(authz, "items.post")}
        canBuy={can(authz, "purchase_orders.create")}
        canSubcontract={await manufacturingFeatureEnabled(
          authz.user.orgId,
          "manufacturingSubcontract",
        )}
        canReadQuality={can(authz, "items.read")}
        canReadJournal={can(authz, "gl.read")}
        canGovernRevisions={canGovernRevisions}
        canRollup={
          can(authz, "manufacturing.manage") &&
          can(authz, "items.manage") &&
          can(authz, "items.post") &&
          authz.allowedSubsidiaryIds === null
        }
      />
    </>
  );
}
