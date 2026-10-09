import Link from "next/link";
import { getTranslations, getLocale } from "next-intl/server";
import { z } from "zod";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { withScopeSnapshot } from "@openbooks/engine/src/organization/subsidiary-scope.ts";
import {
  listManufacturingRecords,
  manufacturingOptions,
  type ManufacturingRow,
  type ManufacturingView,
} from "@openbooks/engine/src/manufacturing/workspace.ts";
import { requirePermission, can } from "@/lib/authz";
import { requireFeatureEnabled } from "@/lib/feature-gates";
import {
  PageHeader,
  Button,
  Input,
  Label,
  Select,
  EmptyState,
  Badge,
} from "@openbooks/ui";
import { ListPageLayout } from "@/components/page-layout";
import { ServerPagedTable } from "@/components/server-paged-table";
import { formatDecimal } from "@/lib/money-format";
import { dateLabel, dateTime } from "@/lib/format";
import { ManufacturingRecordHost } from "./RecordHost";

export type SearchParams = Record<string, string | string[] | undefined>;
const value = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;
const uuid = (v: unknown) => {
  const parsed = z.string().uuid().safeParse(v);
  return parsed.success ? parsed.data : undefined;
};
export const manufacturingSources = {
  "work-orders": "manufacturing_work_orders",
  "work-centers": "manufacturing_work_centers",
  routings: "manufacturing_routings",
  mrp: "manufacturing_mrp",
} as const;
const fields: Record<ManufacturingView, string[]> = {
  "work-orders": [
    "number",
    "itemName",
    "status",
    "priority",
    "quantityOrdered",
    "quantityCompleted",
    "quantityScrapped",
    "unit",
    "plannedStart",
    "plannedEnd",
  ],
  "work-centers": [
    "code",
    "name",
    "kind",
    "status",
    "capacityHoursPerDay",
    "efficiencyPct",
  ],
  routings: [
    "code",
    "name",
    "itemName",
    "version",
    "status",
    "effectiveFrom",
    "effectiveTo",
  ],
  mrp: ["number", "status", "horizonStart", "horizonEnd", "ranAt"],
};
const statuses: Record<ManufacturingView, string[]> = {
  "work-orders": [
    "draft",
    "released",
    "in_progress",
    "on_hold",
    "done",
    "closed",
    "cancelled",
  ],
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
  const t = await getTranslations("manufacturing"),
    locale = await getLocale(),
    basePath = "/manufacturing/" + view;
  const query = {
    q: value(searchParams.q)?.slice(0, 200),
    status: value(searchParams.status),
    subsidiaryId: uuid(value(searchParams.subsidiaryId)),
    page: Math.max(
      1,
      Number.parseInt(value(searchParams.page) ?? "1", 10) || 1,
    ),
    perPage: Math.min(
      100,
      Math.max(
        10,
        Number.parseInt(value(searchParams.perPage) ?? "25", 10) || 25,
      ),
    ),
  };
  const { page, options } = await withScopeSnapshot(
    authz.user.orgId,
    async () => ({
      page: await listManufacturingRecords(
        db,
        authz.user.orgId,
        authz.allowedSubsidiaryIds,
        view,
        query,
      ),
      options: await manufacturingOptions(
        db,
        authz.user.orgId,
        authz.allowedSubsidiaryIds,
        can(authz, "ap.create"),
      ),
    }),
  );
  const recordId = value(searchParams.record),
    validRecord =
      recordId === "new"
        ? can(authz, "manufacturing.manage")
          ? "new"
          : undefined
        : uuid(recordId);
  const params = new URLSearchParams();
  for (const [key, val] of Object.entries(searchParams)) {
    if (key !== "record" && typeof val === "string") params.set(key, val);
  }
  const closeHref = basePath + (params.size ? "?" + params.toString() : ""),
    newParams = new URLSearchParams(params);
  newParams.set("record", "new");
  const label = (v: unknown) =>
    v === null || v === undefined
      ? "—"
      : t.has("values." + String(v))
        ? t("values." + String(v))
        : String(v);
  function cell(key: string, row: ManufacturingRow) {
    if (key === "number" || key === "code") {
      const href = new URLSearchParams(params);
      href.set("record", row.id);
      return (
        <Link
          className="font-medium text-teal-700 hover:underline dark:text-teal-300"
          href={(basePath + "?" + href) as never}
        >
          {label(row[key])}
        </Link>
      );
    }
    const val = row[key];
    const display =
      typeof val === "string" && /^\d{4}-\d{2}-\d{2}$/.test(val)
        ? dateLabel(new Date(val + "T00:00:00Z"), locale)
        : key.endsWith("At") && typeof val === "string"
          ? dateTime(val, locale)
          : /(quantity|Hours|Pct)/i.test(key) && typeof val === "string"
            ? formatDecimal(locale, val, { maximumFractionDigits: 4 })
            : label(val);
    return key === "status" ? <Badge>{display}</Badge> : display;
  }
  return (
    <ListPageLayout
      header={
        <PageHeader
          title={t("titles." + view)}
          description={t("descriptions." + view)}
          actions={
            can(authz, "manufacturing.manage") ? (
              <Button asChild>
                <Link href={(basePath + "?" + newParams) as never}>
                  {t("new." + view)}
                </Link>
              </Button>
            ) : undefined
          }
        />
      }
    >
      <ServerPagedTable
        source={manufacturingSources[view]}
        rows={page.rows}
        columns={fields[view].map((key) => ({
          key,
          header: t("fields." + key),
          cell: (row: ManufacturingRow) => cell(key, row),
        }))}
        rowKey={(row) => row.id}
        basePath={basePath}
        currentParams={Object.fromEntries(params)}
        total={page.total}
        page={page.page}
        perPage={page.perPage}
        empty={
          <EmptyState
            title={t("empty." + view)}
            description={t("emptyNote." + view)}
          />
        }
        toolbar={
          <form action={basePath} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="mfg-search">{t("search")}</Label>
              <Input
                id="mfg-search"
                name="q"
                defaultValue={query.q}
                placeholder={t("searchPlaceholder")}
                className="w-52"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="mfg-status">{t("fields.status")}</Label>
              <Select
                id="mfg-status"
                name="status"
                defaultValue={query.status ?? ""}
              >
                <option value="">{t("allStatuses")}</option>
                {statuses[view].map((status) => (
                  <option key={status} value={status}>
                    {label(status)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="mfg-entity">{t("fields.subsidiaryId")}</Label>
              <Select
                id="mfg-entity"
                name="subsidiaryId"
                defaultValue={query.subsidiaryId ?? ""}
              >
                <option value="">{t("allEntities")}</option>
                {options.subsidiaries.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <input type="hidden" name="perPage" value={page.perPage} />
            <Button type="submit" variant="outline">
              {t("filter")}
            </Button>
            {params.size ? (
              <Button variant="ghost" asChild>
                <Link href={basePath as never}>{t("clear")}</Link>
              </Button>
            ) : null}
          </form>
        }
      />
      <ManufacturingRecordHost
        view={view}
        recordId={validRecord}
        closeHref={closeHref}
        options={options}
        canManage={can(authz, "manufacturing.manage")}
        canPost={can(authz, "items.post")}
        canBuy={authz.permissions.has("ap.create")}
        canReadJournal={can(authz, "gl.read")}
      />
    </ListPageLayout>
  );
}
