import "server-only";
import { isFeatureEnabled } from "@/lib/features";

import { getLocale, getTranslations } from "next-intl/server";
import { sql, type SQL } from "drizzle-orm";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import {
  AmortizationError,
  listScheduleRows,
  listCurrentTemplates,
  loadScheduleDetail,
  reconcileDeferralAccounts,
  type ScheduleDetail,
} from "@openbooks/engine/amortization";
import { db } from "@openbooks/engine/platform/database";
import { businessToday } from "@openbooks/engine/platform/business-date";
import { periodDisplayLabel } from "@openbooks/engine/periods/period-policy";
import { can, requirePermission } from "../../../../lib/authz";
import { requireFeatureEnabled } from "../../../../lib/feature-gates";
import { isUuid, mergeHref, pickString } from "../../../../lib/list-params";
import { loadAccounts } from "../../../../lib/setup/ref-options";
import { builtInReportDefinitionId } from "../../../../lib/custom-reports";
import { amortizationSourceHref } from "../../../../lib/amortization-source-link";

/**
 * Accounting → Amortization: prepaid and deferred expense schedules.
 *
 * Three peer views behind URL tabs, one body at a time: the schedule list
 * (with its drawer), the period run, and the deferral-account
 * reconciliation. Every read is scoped to the subsidiaries the reader's role
 * reaches; every command re-checks the permission and scope in the engine.
 */

const BASE = "/accounting/amortization";
const STATUSES = ["draft", "active", "on_hold", "completed", "cancelled"] as const;
const DESTINATION_TYPES = new Set(["cogs", "expense", "expense_other", "expense_deferred"]);

export interface AmortizationScheduleRow {
  id: string;
  href: string;
  number: string;
  status: string;
  source: string;
  sourceHref: string | null;
  template: string;
  subsidiary: string;
  currency: string;
  total: string;
  amortized: string;
  remaining: string;
  nextPeriod: string | null;
}

export interface AmortizationDueRow {
  id: string;
  scheduleNumber: string;
  scheduleHref: string;
  period: string;
  account: string;
  amount: string;
  currency: string;
}

export interface AmortizationReconciliationRow {
  id: string;
  book: string;
  subsidiary: string;
  account: string;
  currency: string;
  ledger: string;
  subledger: string;
  difference: string;
  openSchedules: number;
}

export interface AmortizationScheduleDrawerData {
  detail: ScheduleDetail;
  canManage: boolean;
  closeHref: string;
  destinationAccounts: { value: string; label: string; subsidiaryIds: string[] }[];
}

export interface AmortizationNewScheduleData {
  books: { id: string; label: string; currencies: Record<string, string> }[];
  templates: { id: string; label: string }[];
  subsidiaries: { id: string; label: string }[];
  destinationAccounts: { value: string; label: string; subsidiaryIds: string[] }[];
}

export interface AmortizationData {
  title: string;
  description: string;
  currentParams: Record<string, string | string[] | undefined>;
  canManage: boolean;
  tabs: { href: string; label: string; active?: boolean; count?: number | null }[];
  onSchedules: boolean;
  onRun: boolean;
  onReconciliation: boolean;
  statusFilter: string;
  statusTabs: { href: string; label: string; active: boolean }[];
  schedules: AmortizationScheduleRow[];
  drawerOpen: boolean;
  drawer: AmortizationScheduleDrawerData | null;
  periods: { id: string; name: string; endsOn: string }[];
  selectedPeriodId: string | null;
  due: AmortizationDueRow[];
  asOf: string;
  reconciliation: AmortizationReconciliationRow[];
  newSchedule: AmortizationNewScheduleData | null;
  templatesHref: string;
  waterfallHref: string | null;
  reconciliationReportHref: string | null;
}

function reportHref(id: string | null): string | null {
  return id ? `/reports/custom/run/${id}` : null;
}

function subsidiaryFilter(column: SQL, allowed: ReadonlySet<string> | null) {
  if (!allowed) return sql``;
  return sql`and ${column} = any(${`{${[...allowed].join(",")}}`}::uuid[])`;
}

export async function loadAmortization(
  sp: Record<string, string | string[] | undefined>,
): Promise<AmortizationData> {
  const t = await getTranslations("amortization");
  const authz = await requirePermission("amortization.read");
  const orgId = authz.user.orgId;
  await requireFeatureEnabled(orgId, "expenseAmortization");
  const canManage = can(authz, "amortization.manage");
  const allowed = authz.allowedSubsidiaryIds;
  const today = await businessToday(orgId);

  const requestedView = pickString(sp.view);
  const scheduleParam = pickString(sp.schedule);
  const view: "schedules" | "run" | "reconciliation" = scheduleParam
    ? "schedules"
    : requestedView === "run" || requestedView === "reconciliation"
      ? requestedView
      : "schedules";

  const requestedStatus = pickString(sp.status);
  const statusFilter =
    requestedStatus && (STATUSES as readonly string[]).includes(requestedStatus)
      ? requestedStatus
      : "open";
  const scheduleRows =
    view === "schedules"
      ? await listScheduleRows(db, orgId, {
          status: statusFilter as
            "open" | "draft" | "active" | "on_hold" | "completed" | "cancelled",
          allowedSubsidiaryIds: allowed,
          limit: 2000,
        })
      : [];
  const schedules: AmortizationScheduleRow[] = scheduleRows.map((row) => {
    return {
      id: row.id,
      href: mergeHref(BASE, sp, { schedule: row.id }),
      number: row.schedule_number,
      status: row.status,
      source: row.document_number
        ? `${t(`sourceKind.${row.source_kind}`)} ${row.document_number}`
        : t(`sourceKind.${row.source_kind}`),
      sourceHref: amortizationSourceHref(row.source_kind, row.source_document_id),
      template: row.template_code,
      subsidiary: row.subsidiary_name ?? "—",
      currency: row.currency,
      total: row.total_amount,
      amortized: row.amortized,
      remaining: row.remaining,
      nextPeriod: row.next_period ? row.next_period.slice(0, 7) : null,
    };
  });

  let drawer: AmortizationScheduleDrawerData | null = null;
  const accounts = canManage ? await loadAccounts(orgId, allowed) : [];
  const destinationAccounts = accounts
    .filter((account) => account.accountType && DESTINATION_TYPES.has(account.accountType))
    .map((account) => ({
      value: account.value,
      label: account.label,
      subsidiaryIds: account.subsidiaryIds ?? [],
    }));
  if (scheduleParam && isUuid(scheduleParam)) {
    try {
      const detail = await loadScheduleDetail(db, orgId, scheduleParam);
      if (!allowed || allowed.has(detail.schedule.subsidiaryId)) {
        const requestedReturn = pickString(sp.drawerReturn);
        drawer = {
          detail,
          canManage,
          closeHref: requestedReturn?.startsWith(BASE)
            ? requestedReturn
            : mergeHref(BASE, sp, { schedule: undefined }),
          destinationAccounts,
        };
      }
    } catch (error) {
      if (!(error instanceof AmortizationError) || error.status !== 404) throw error;
    }
  }

  // Run-period options read by fiscal position and month in the viewer's locale.
  const locale = await getLocale();
  const periods = (
    await db.execute<{
      id: string;
      fiscal_year: number;
      period_number: number;
      starts_on: string;
      ends_on: string;
    }>(
      sql`
    select id, fiscal_year, period_number, starts_on::text as starts_on, ends_on::text as ends_on from accounting_periods
     where org_id = ${orgId} and not is_adjustment
     order by starts_on desc
     limit 60`,
      "objects",
    )
  ).map((row) => ({
    id: row.id,
    name: periodDisplayLabel(
      {
        fiscalYear: Number(row.fiscal_year),
        periodNumber: Number(row.period_number),
        adjustment: false,
        startsOn: row.starts_on,
        endsOn: row.ends_on,
      },
      locale,
    ),
    endsOn: row.ends_on,
  }));
  const requestedPeriod = pickString(sp.period);
  const selectedPeriod =
    periods.find((period) => period.id === requestedPeriod) ??
    periods.find(
      (period) => period.endsOn >= today && period.endsOn.slice(0, 7) === today.slice(0, 7),
    ) ??
    periods.find((period) => period.endsOn <= today) ??
    periods[0] ??
    null;
  const due: AmortizationDueRow[] =
    view === "run" && selectedPeriod
      ? (
          await db.execute<{
            id: string;
            schedule_id: string;
            schedule_number: string;
            period_start: string;
            account: string;
            amount: string;
            currency: string;
          }>(
            sql`
        select l.id, s.id as schedule_id, s.schedule_number, l.period_start::text as period_start,
               concat_ws(' · ', a.number, a.name) as account, l.planned_amount::text as amount, s.currency
          from expense_amortization_schedule_lines l
          join expense_amortization_schedules s on s.org_id = l.org_id and s.id = l.schedule_id
          join accounts a on a.org_id = l.org_id and a.id = l.destination_account_id
         where l.org_id = ${orgId} and l.status = 'planned' and s.status = 'active'
           and l.period_end <= ${selectedPeriod.endsOn}
           ${subsidiaryFilter(sql`s.subsidiary_id`, allowed)}
         order by s.schedule_number, l.period_start
         limit 2000`,
            "objects",
          )
        ).map((row) => ({
          id: row.id,
          scheduleNumber: row.schedule_number,
          scheduleHref: mergeHref(BASE, {}, { schedule: row.schedule_id }),
          period: row.period_start.slice(0, 7),
          account: row.account,
          amount: row.amount,
          currency: row.currency,
        }))
      : [];

  const requestedAsOf = pickString(sp.asOf);
  const asOf = requestedAsOf && /^\d{4}-\d{2}-\d{2}$/.test(requestedAsOf) ? requestedAsOf : today;
  let reconciliation: AmortizationReconciliationRow[] = [];
  if (view === "reconciliation") {
    const rows = await reconcileDeferralAccounts(db, orgId, { asOf, subsidiaryIds: allowed });
    const names = await referenceNames(orgId, rows);
    reconciliation = rows.map((row) => ({
      id: `${row.bookId}:${row.subsidiaryId}:${row.currency}:${row.accountId}`,
      book: names.books.get(row.bookId) ?? row.bookId,
      subsidiary: names.subsidiaries.get(row.subsidiaryId) ?? row.subsidiaryId,
      account: names.accounts.get(row.accountId) ?? row.accountId,
      currency: row.currency,
      ledger: row.ledger,
      subledger: row.subledger,
      difference: row.difference,
      openSchedules: row.openSchedules,
    }));
  }

  const newSchedule: AmortizationNewScheduleData | null = canManage
    ? {
        books: await db.execute<{ id: string; label: string; currencies: Record<string, string> }>(
          sql`
          select b.id, concat_ws(' · ', b.code, b.name) as label,
                 coalesce((select jsonb_object_agg(s.id::text, public.accounting_book_currency(${orgId}, b.id, s.id)) from subsidiaries s
                   where s.org_id = b.org_id and s.is_active and not s.is_elimination ${subsidiaryFilter(sql`s.id`, allowed)}), '{}'::jsonb) as currencies
          from accounting_books b where b.org_id = ${orgId} and b.is_active and b.posts_gl
            ${(await isFeatureEnabled(orgId, "multiBookAccounting")) ? sql`` : sql`and b.is_primary`}
          order by b.is_primary desc, b.code`,
          "objects",
        ),
        templates: (await listCurrentTemplates(db, orgId, today)).map((template) => ({
          id: template.id,
          label: `${template.code} · ${template.name}`,
        })),
        subsidiaries: (
          await db.execute<{ id: string; name: string }>(
            sql`
          select id, name from subsidiaries
           where org_id = ${orgId} and is_active and not coalesce(is_elimination, false)
             ${subsidiaryFilter(sql`id`, allowed)}
           order by name`,
            "objects",
          )
        ).map((row) => ({ id: row.id, label: row.name })),
        destinationAccounts,
      }
    : null;

  const tab = (key: "schedules" | "run" | "reconciliation") => ({
    href: mergeHref(BASE, {}, { view: key === "schedules" ? undefined : key }),
    label: t(`views.${key}`),
    active: view === key,
  });

  return {
    title: t("workspace.title"),
    description: t("workspace.description"),
    currentParams: sp,
    canManage,
    tabs: [tab("schedules"), tab("run"), tab("reconciliation")],
    onSchedules: view === "schedules",
    onRun: view === "run",
    onReconciliation: view === "reconciliation",
    statusFilter,
    statusTabs: ["open", ...STATUSES].map((status) => ({
      href: mergeHref(BASE, {}, { status: status === "open" ? undefined : status }),
      label: t(`statusFilter.${status}`),
      active: status === statusFilter,
    })),
    schedules,
    drawerOpen: drawer !== null,
    drawer,
    periods,
    selectedPeriodId: selectedPeriod?.id ?? null,
    due,
    asOf,
    reconciliation,
    newSchedule,
    templatesHref: "/admin/setup/expense-amortization-templates",
    waterfallHref: reportHref(await builtInReportDefinitionId(orgId, "prepaid-expense-waterfall")),
    reconciliationReportHref: reportHref(
      await builtInReportDefinitionId(orgId, "prepaid-expense-reconciliation"),
    ),
  };
}

async function referenceNames(
  orgId: string,
  rows: { bookId: string; subsidiaryId: string; accountId: string }[],
) {
  const ids = (values: string[]) => `{${[...new Set(values)].join(",")}}`;
  if (rows.length === 0)
    return {
      books: new Map<string, string>(),
      subsidiaries: new Map<string, string>(),
      accounts: new Map<string, string>(),
    };
  const [books, subsidiaries, accounts] = await Promise.all([
    db.execute<{ id: string; name: string }>(
      sql`
      select id, name from accounting_books where org_id = ${orgId} and id = any(${ids(rows.map((r) => r.bookId))}::uuid[])`,
      "objects",
    ),
    db.execute<{ id: string; name: string }>(
      sql`
      select id, name from subsidiaries where org_id = ${orgId} and id = any(${ids(rows.map((r) => r.subsidiaryId))}::uuid[])`,
      "objects",
    ),
    db.execute<{ id: string; label: string }>(
      sql`
      select id, concat_ws(' · ', number, name) as label from accounts where org_id = ${orgId} and id = any(${ids(rows.map((r) => r.accountId))}::uuid[])`,
      "objects",
    ),
  ]);
  return {
    books: new Map(books.map((row) => [row.id, row.name])),
    subsidiaries: new Map(subsidiaries.map((row) => [row.id, row.name])),
    accounts: new Map(accounts.map((row) => [row.id, row.label])),
  };
}

const f = ref<AmortizationData>();

export function amortizationSpec(data: AmortizationData): PageSpec {
  return page({
    route: "/accounting/amortization",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        actions: [
          widget("module-home-tabs", { tabs: data.tabs }),
          widget(
            "amortization-new-schedule",
            { data: data.newSchedule, templatesHref: data.templatesHref },
            f("canManage"),
          ),
        ],
      }),
    ],
    body: [
      {
        ...widgetBlock("amortization-schedules", {
          rows: data.schedules,
          statusTabs: data.statusTabs,
          templatesHref: data.templatesHref,
          waterfallHref: data.waterfallHref,
        }),
        when: f("onSchedules"),
      },
      {
        ...widgetBlock("amortization-run", {
          periods: data.periods,
          selectedPeriodId: data.selectedPeriodId,
          due: data.due,
          canManage: data.canManage,
        }),
        when: f("onRun"),
      },
      {
        ...widgetBlock("amortization-reconciliation", {
          asOf: data.asOf,
          rows: data.reconciliation,
          reportHref: data.reconciliationReportHref,
        }),
        when: f("onReconciliation"),
      },
      {
        ...widgetBlock("amortization-schedule-drawer", { drawer: data.drawer }),
        when: f("drawerOpen"),
      },
    ],
  });
}
