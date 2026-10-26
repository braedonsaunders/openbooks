import "server-only";

import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { db } from "@openbooks/engine/platform/db";
import { filterTaxReturnFormsByFeatures } from "@openbooks/engine/tax-returns/return";
import { readMigrationPlan } from "../../../lib/migration/plan";
import {
  badge,
  column,
  field,
  link,
  number,
  page,
  pageHeader,
  ref,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission } from "../../../lib/authz";
import { accessDeniedHref } from "../../../lib/gate-targets";
import { TAX_FILING_WRITE_PERMISSION } from "../../../lib/tax-filing-permission";
import { isUuid, mergeHref, parseListParams, pickString } from "../../../lib/list-params";
import { registeredListTable } from "../../../lib/list/prepared-spec";
import type { ModuleHomeTab } from "@/components/module-home/tab-types";
import { taxWorkspaceTabs } from "./workspace-tabs";
import type { FilingAdjustmentRecord, FilingHistoryRecord } from "./FilingHistoryDrawer";
import type { ProviderActivityPayload } from "./ProviderActivityDrawer";
import type { TaxFormOption, TaxHistoryRow } from "./sections";

/**
 * Tax filings use the shared list layout and registered history table. The
 * loader owns authorization, filtering, sorting and the server page; the spec
 * composes those rows with native interactive panels. Entity-restricted
 * callers remain refused at the page boundary, and filing actions stay gated
 * by the same permissions as their API routes.
 */

type FormRow = {
  code: string;
  name: string;
  country: string | null;
  submission_channel: string;
  government_format: string;
  submission_url: string | null;
  notice_key: string | null;
  has_official: boolean;
};

type FilingRow = Omit<FilingHistoryRecord, "adjustments"> & { created_at: string };

/** A stored filing as read: its adjustments are the raw JSON until resolved. */
type SelectedFilingRow = Omit<FilingHistoryRecord, "adjustments"> & { adjustments: unknown };

/**
 * The adjustment entries a stored filing carries, with each author's name.
 * Prepared v3 filings hold their governed entries; earlier filings hold an
 * amount per line, which is listed without a reason or author.
 */
async function filingAdjustmentRecords(
  orgId: string,
  raw: unknown,
): Promise<FilingAdjustmentRecord[]> {
  const entries: {
    lineCode: string;
    amount: string;
    reason: string | null;
    enteredBy: string | null;
    enteredAt: string | null;
  }[] = Array.isArray(raw)
    ? raw.map((entry: Record<string, unknown>) => ({
        lineCode: String(entry.lineCode),
        amount: String(entry.amount),
        reason: typeof entry.reason === "string" ? entry.reason : null,
        enteredBy: typeof entry.enteredBy === "string" ? entry.enteredBy : null,
        enteredAt: typeof entry.enteredAt === "string" ? entry.enteredAt : null,
      }))
    : raw && typeof raw === "object"
      ? Object.entries(raw as Record<string, unknown>).map(([lineCode, amount]) => ({
          lineCode,
          amount: String(amount),
          reason: null,
          enteredBy: null,
          enteredAt: null,
        }))
      : [];
  const authorIds = [
    ...new Set(
      entries
        .map((entry) => entry.enteredBy)
        .filter((id): id is string => Boolean(id) && isUuid(id!)),
    ),
  ];
  const names = new Map<string, string>();
  if (authorIds.length > 0) {
    const users = await db.execute<{ id: string; name: string }>(
      sql`
      select id::text as id, name from users
       where org_id = ${orgId} and id::text in (${sql.join(
         authorIds.map((id) => sql`${id}`),
         sql`, `,
       )})`,
      "objects",
    );
    for (const user of users) names.set(user.id, user.name);
  }
  return entries.map((entry) => ({
    lineCode: entry.lineCode,
    amount: entry.amount,
    reason: entry.reason,
    enteredByName: entry.enteredBy ? (names.get(entry.enteredBy) ?? null) : null,
    enteredAt: entry.enteredAt,
  }));
}

export interface TaxHistoryTableData {
  searchPlaceholder: string;
  statusLabel: string;
  statusOptions: { value: string; label: string }[];
  formLabel: string;
  formOptions: { value: string; label: string }[];
  basePath: string;
  currentParams: Record<string, string | string[] | undefined>;
  total: number;
  page: number;
  perPage: number;
  sort: string;
  dir: "asc" | "desc";
  columnForm: string;
  columnPeriod: string;
  columnVersion: string;
  columnStatus: string;
  columnReference: string;
  columnSaved: string;
  empty: string;
  rows: TaxHistoryRow[];
}

export interface TaxData {
  title: string;
  description: string;
  setupHref: string;
  setupLabel: string;
  canManageSetup: boolean;
  tabKey: string;
  onPrepare: boolean;
  onHistory: boolean;
  onActivity: boolean;
  tabs: { key: string; href: string; label: string; active: boolean; count: number | null }[];
  workspaceTabs: ModuleHomeTab[];
  forms: TaxFormOption[];
  /** The organization's conversion date (ISO), null when no migration cutover is recorded. */
  conversionDate: string | null;
  canSave: boolean;
  history: TaxHistoryTableData;
  currentParams: Record<string, string | string[] | undefined>;
  activityDrawer: {
    widget: "tax-provider-activity-drawer";
    props: {
      drawer: { activity: ProviderActivityPayload; canRetry: boolean; closeHref: string } & {
        remountKey: string;
      };
    };
  } | null;
  activityEmptyTitle: string;
  activityEmptyDescription: string;
  drawerOpen: boolean;
  drawer: {
    remountKey: string;
    filing: FilingHistoryRecord;
    closeHref: string;
    canFile: boolean;
  } | null;
}

export async function loadTax(sp: Record<string, string | string[] | undefined>): Promise<TaxData> {
  const authz = await requirePermission("reports.read");
  // Returns and filings have no subsidiary dimension: every tax REST path
  // refuses an entity-restricted caller (guardSubsidiaryScope(gate, null) → 404).
  // This page applies the identical fence — the same callers are refused —
  // but names it (F1T-10) instead of answering a silent 404.
  if (authz.allowedSubsidiaryIds !== null) {
    redirect(accessDeniedHref({ permission: "unrestricted subsidiary access" }));
  }
  const { orgId } = authz.user;
  const t = await getTranslations("tax");
  const workspaceTabs = await taxWorkspaceTabs(orgId, "filings");
  const rawTab = pickString(sp.tab);
  const tab = rawTab === "history" ? "history" : rawTab === "activity" ? "activity" : "prepare";
  const list = parseListParams(sp, {
    sort: "period",
    dir: "desc",
    perPage: 20,
    allowedSorts: ["period", "form", "status", "created"] as const,
  });
  const status = pickString(sp.status);
  const formCode = pickString(sp.form);
  const filingId = pickString(sp.filing);
  const activityId = pickString(sp.activity);
  const canManageSetup = can(authz, "admin.setup.manage");

  const formsResult = await db.execute<FormRow>(
    sql`
    select code, name, country, submission_channel, government_format, submission_url,
           notice_key, official_pdf_file_id is not null as has_official
      from tax_return_forms
     where org_id = ${orgId} and is_active
     order by country nulls last, name`,
    "objects",
  );
  const forms = await filterTaxReturnFormsByFeatures(orgId, formsResult);

  const filters = sql`where org_id = ${orgId}
    ${status === "prepared" || status === "filed" ? sql`and status = ${status}` : sql``}
    ${formCode && forms.some((form) => form.code === formCode) ? sql`and form_code = ${formCode}` : sql``}
    ${
      list.q
        ? sql`and (
      form_name ilike ${`%${list.q}%`} or form_code ilike ${`%${list.q}%`} or
      coalesce(filing_reference, '') ilike ${`%${list.q}%`} or
      cast(period_from as text) ilike ${`%${list.q}%`} or cast(period_to as text) ilike ${`%${list.q}%`}
    )`
        : sql``
    }`;
  const order =
    list.sort === "form"
      ? sql`form_name ${list.dir === "asc" ? sql`asc` : sql`desc`}, period_to desc`
      : list.sort === "status"
        ? sql`status ${list.dir === "asc" ? sql`asc` : sql`desc`}, period_to desc`
        : list.sort === "created"
          ? sql`created_at ${list.dir === "asc" ? sql`asc` : sql`desc`}`
          : sql`period_to ${list.dir === "asc" ? sql`asc` : sql`desc`}, version desc`;

  // The History badge and the list total come from one count over the same
  // filters the list applies, so the badge always matches the rows listed.
  // The full history rows are only queried when that tab is open. The Activity
  // tab's badge counts failed provider commits — the rows that need the operator.
  const [failedResult, historyResult, countResult, selectedResult, activityResult] =
    await Promise.all([
      db.execute<{ count: number }>(
        sql`select count(*)::int as count from tax_provider_transactions where org_id = ${orgId} and status = 'failed'`,
        "objects",
      ),
      tab === "history"
        ? db.execute<FilingRow>(
            sql`
          select id, form_name, form_code, country, period_from::text, period_to::text,
                 version, status, filing_reference, filed_at::text, snapshot_hash, boxes, created_at::text
            from tax_filings ${filters}
           order by ${order}
           limit ${list.perPage} offset ${(list.page - 1) * list.perPage}`,
            "objects",
          )
        : Promise.resolve([] as FilingRow[]),
      db.execute<{ count: number }>(
        sql`select count(*)::int as count from tax_filings ${filters}`,
        "objects",
      ),
      filingId && isUuid(filingId)
        ? db.execute<SelectedFilingRow>(
            sql`
          select id, form_name, form_code, country, period_from::text, period_to::text,
                 version, status, filing_reference, filed_at::text, snapshot_hash, boxes, adjustments
            from tax_filings where id = ${filingId} and org_id = ${orgId} limit 1`,
            "objects",
          )
        : Promise.resolve([] as SelectedFilingRow[]),
      activityId && isUuid(activityId)
        ? db.execute<ProviderActivityPayload>(
            sql`
          select t.id::text as id, t.document_id::text as "documentId",
                 d.document_number as "documentNumber", d.kind as "documentKind",
                 t.provider, t.provider_code as "providerCode", t.kind, t.status,
                 t.attempts, t.next_attempt_at::text as "nextAttemptAt",
                 t.last_error as "lastError", t.committed_at::text as "committedAt",
                 t.provider_response_excerpt as "excerpt"
            from tax_provider_transactions t
            join documents d on d.id = t.document_id and d.org_id = t.org_id
           where t.id = ${activityId} and t.org_id = ${orgId} limit 1`,
            "objects",
          )
        : Promise.resolve([] as ProviderActivityPayload[]),
    ]);
  const failedCount = Number(failedResult[0]?.count ?? 0);
  const history = historyResult;
  const total = Number(countResult[0]?.count ?? 0);
  const selectedRow = selectedResult[0];
  const selected = selectedRow
    ? { ...selectedRow, adjustments: await filingAdjustmentRecords(orgId, selectedRow.adjustments) }
    : undefined;
  const conversionDate = (await readMigrationPlan(orgId)).cutoverDate;
  const closeHref = mergeHref("/tax", sp, { filing: undefined });
  const activity = activityResult[0];
  const activityCloseHref = mergeHref("/tax", sp, { activity: undefined });
  const activityDrawer: TaxData["activityDrawer"] = activity
    ? {
        widget: "tax-provider-activity-drawer",
        props: {
          drawer: {
            activity,
            canRetry: can(authz, TAX_FILING_WRITE_PERMISSION),
            closeHref: activityCloseHref,
            remountKey: activity.id,
          },
        },
      }
    : null;

  return {
    title: t("title"),
    description: t("description"),
    setupHref: "/admin/setup/tax-return-forms",
    setupLabel: t("setup"),
    canManageSetup,
    tabKey: tab,
    onPrepare: tab === "prepare",
    onHistory: tab === "history",
    onActivity: tab === "activity",
    tabs: [
      {
        key: "prepare",
        label: t("tabs.prepare"),
        href: "/tax",
        active: tab === "prepare",
        count: null,
      },
      {
        key: "history",
        label: t("tabs.history"),
        href: "/tax?tab=history",
        active: tab === "history",
        count: total,
      },
      {
        key: "activity",
        label: t("tabs.activity"),
        href: "/tax?tab=activity",
        active: tab === "activity",
        count: failedCount,
      },
    ],
    workspaceTabs,
    currentParams: sp,
    activityDrawer,
    activityEmptyTitle: t("activity.emptyTitle"),
    activityEmptyDescription: t("activity.emptyDescription"),
    forms: forms.map((form) => ({ ...form })),
    conversionDate,
    canSave: can(authz, TAX_FILING_WRITE_PERMISSION),
    history: {
      searchPlaceholder: t("history.search"),
      statusLabel: t("history.statusLabel"),
      statusOptions: [
        { value: "prepared", label: t("history.status.prepared") },
        { value: "filed", label: t("history.status.filed") },
      ],
      formLabel: t("form"),
      formOptions: forms.map((form) => ({ value: form.code, label: form.name })),
      basePath: "/tax",
      currentParams: sp,
      total,
      page: list.page,
      perPage: list.perPage,
      sort: list.sort,
      dir: list.dir,
      columnForm: t("history.columns.form"),
      columnPeriod: t("history.columns.period"),
      columnVersion: t("history.columns.version"),
      columnStatus: t("history.columns.status"),
      columnReference: t("history.columns.reference"),
      columnSaved: t("history.columns.saved"),
      empty: t("history.empty"),
      rows: history.map((filing) => ({
        id: String(filing.id),
        formName: filing.form_name,
        formCode: filing.form_code,
        filingHref: mergeHref("/tax", sp, { filing: filing.id }),
        period: t("period", { from: filing.period_from, to: filing.period_to }),
        version: filing.version,
        status: filing.status,
        statusVariant: (filing.status === "filed" ? "success" : "warning") as "success" | "warning",
        statusLabel: t(`history.status.${filing.status}`),
        reference: filing.filing_reference ?? "—",
        saved: filing.created_at.slice(0, 10),
      })),
    },
    drawerOpen: Boolean(selected),
    drawer: selected
      ? {
          remountKey: String(selected.id),
          filing: selected,
          closeHref,
          canFile: can(authz, TAX_FILING_WRITE_PERMISSION),
        }
      : null,
  };
}

const f = ref<TaxData>();
const item = field;

export function taxSpec(data: TaxData): PageSpec {
  return page({
    route: "/tax",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget("module-home-tabs", { tabs: f("workspaceTabs") }),
          ...(data.canManageSetup
            ? [
                widget("link-button", {
                  href: f("setupHref"),
                  iconKey: "settings",
                  label: f("setupLabel"),
                  size: "sm",
                  variant: "outline",
                }),
              ]
            : []),
        ],
      }),
    ],
    body: [
      widgetBlock("tax-page", {
        tabs: data.tabs,
        onPrepare: data.onPrepare,
        forms: data.forms,
        conversionDate: data.conversionDate,
        canSave: data.canSave,
      }),
      {
        ...registeredListTable(
          "tax_filings_history",
          {
            variant: "app",
            rows: f("history.rows"),
            rowKey: item("id"),
            sorting: {
              basePath: "/tax?tab=history",
              sort: f("history.sort"),
              dir: f("history.dir"),
            },
            columns: [
              column(
                f("history.columnForm"),
                link(
                  item("formName"),
                  item("filingHref"),
                  "font-medium text-teal-700 hover:underline dark:text-teal-300",
                ),
                { sort: "form" },
              ),
              column(f("history.columnPeriod"), text(item("period")), { sort: "period" }),
              column(f("history.columnVersion"), number(item("version"))),
              column(
                f("history.columnStatus"),
                badge(item("statusLabel"), { variant: item("statusVariant") }),
                { sort: "status" },
              ),
              column(f("history.columnReference"), text(item("reference"))),
              column(f("history.columnSaved"), text(item("saved")), { sort: "created" }),
            ],
            emptyRow: { text: f("history.empty"), colSpan: 6 },
          },
          [
            widget("list-toolbar", {
              basePath: "/tax?tab=history",
              currentParams: f("history.currentParams"),
              search: { placeholder: f("history.searchPlaceholder") },
              filters: [
                {
                  paramKey: "status",
                  label: f("history.statusLabel"),
                  options: f("history.statusOptions"),
                },
                {
                  paramKey: "form",
                  label: f("history.formLabel"),
                  options: f("history.formOptions"),
                },
              ],
            }),
          ],
        ),
        when: f("onHistory"),
      },
      {
        // The provider commit queue shares the page with the filings shell:
        // the shell owns the tab strip while the list reads every other key,
        // the same split the collections page gave its attempts queue.
        ...widgetBlock("entity-list-view", {
          recordType: "tax_provider_transaction",
          sp: f("currentParams"),
          drawer: f("activityDrawer"),
          emptyTitle: f("activityEmptyTitle"),
          emptyDescription: f("activityEmptyDescription"),
        }),
        when: f("onActivity"),
      },
      { ...widgetBlock("tax-filing-drawer", { drawer: data.drawer }), when: f("drawerOpen") },
    ],
  });
}
