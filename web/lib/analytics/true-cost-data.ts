import "server-only";
import { analyticsQuery } from "./query";
import { analyticsSection } from "./read-context";
import { toChartNumber } from "../chart-number";
import { statementBookExpr } from "../gl-summary";
import { isFeatureEnabled } from "../features";
import { getMoneyFormatter } from '../money-server'
import { sql } from "drizzle-orm";
import { utcDateFromParts } from "@openbooks/engine/src/platform/business-date.ts";
import { add, cmp, div, fromUnits, mulDecimal, mulRatio, normalizeMoney, roundDiv, toUnits } from "@openbooks/engine/src/money/money.ts";
import {
  deriveOverheadCategoryDeptRates,
  deriveOverheadOverallRate,
  deriveOverheadDisplayRate,
  OverheadCalculationError,
  deriveOverheadDeptComposite,
  formatOverheadPublishRate,
  overheadPublishBlockers,
  quantizeOverheadMoney,
  type OverheadPublishBlocker,
  type OverheadRefusalCode,
} from "@openbooks/engine/src/projects/overhead-rates.ts";
import { flowRates } from "../fx-presentation";
import { resolveAccountGroups } from "../account-groups";
import { overheadApplicationSettings } from "@openbooks/engine/allocations/overhead-application";
import { resolveAnnualHoursMany } from "@openbooks/engine/projects/labor-costing";
import { loadWorkSchedules, pickWorkSchedule } from "@openbooks/engine/payroll/work-schedules";
import {
  type AllocationBase,
  type AllocationMethod,
  type RateFormat,
  type CompositeMethod,
  type AllocationBaseBundle,
  formatRate,
  calculateManualCategoryData,
  calculateDerivedCategoryData,
  calculateFormulaCategoryData,
} from "./true-cost-engine";
import { trueCostStrings, type TrueCostStrings } from "./true-cost-strings";
import { englishCatalogMessage } from "./catalog-strings";

/**
 * True Cost — data and calculations for the Burden (Rate Engine) dashboard.
 *
 * The engine is DEPARTMENT-BASED: burden categories (native account groups in
 * the `burden` dimension — the category manager maps onto the rule+pin
 * primitive) × departments form a rate MATRIX of $/hr rates. The composite
 * burden rate = total burden expense ÷ billed labour hours; each department
 * gets its own composite from its department-tagged expense and its own billed
 * hours (untagged expense is allocated across departments by billed-hours
 * share, the allocation-base behaviour).
 *
 * Burden scope: overhead-type expense accounts — expense/expense_other/
 * expense_deferred accounts EXCLUDING direct labour (per the `cost_pool`
 * dimension); COGS is direct cost, never burden. Accounts with spend that no
 * burden category matches surface as "Unassigned".
 *
 * Applied overhead is read from the organization's configured overhead
 * application account (`overheadApplicationSettings`, the same account the
 * posting kernel writes) restricted to `origin = 'overhead_applied'`
 * project-tagged legs — the same legs `listOverheadApplications` sums. The
 * pair's offsetting untagged leg nets to zero on the same account, so only
 * the project-tagged legs measure applied burden. Labour dollars are the
 * configured `cost_pool` / `direct_labor` account group (rule plus pin),
 * the same classification that excludes direct labour from burden below.
 *
 * (Absorption modelling is unchanged by this classification fix and is
 * addressed separately.)
 */

/**
 * A composite/KPI-level refusal: the composite cannot blend, but every
 * category, department and editor still renders. `code` is the typed catalog
 * key suffix (`trueCost.refusals.<code>` in all seven locales); `message`
 * is the request-locale rendering naming the remedy that exists.
 */
export interface TrueCostRefusal {
  code: OverheadRefusalCode | "perFteNoHoursDept" | "cascadingNoLaborDept";
  message: string;
}

export interface Dept {
  id: string;
  name: string;
  billedHours: number;
  totalHours: number;
  /** Non-billable hours with no cost rate (display twin of the exact map). */
  unratedHours: number;
  /** Dept burden ÷ dept billed hours; null when this scope's blend refuses. */
  composite: number | null; // dept burden ÷ dept billed hours
  /**
   * Exact 2dp department rate from the shared engine contract — the value
   * publication persists. Empty when the publish gate blocks (see
   * `ratePublication`); publication refuses before reading it.
   */
  compositeExact: string;
}

export interface BurdenAccount {
  id: string;
  number: string | null;
  name: string;
  /** Exact account total (decimal string). */
  amount: string;
  /** Classification source: explicitly pinned vs matched by the group's rule. */
  pinned: boolean;
  /** Department-TAGGED exact amounts (untagged remainder allocates by hours share). */
  deptAmounts: Record<string, string>;
  untaggedAmount: string;
}

export interface BurdenCategory {
  id: string;
  key: string;
  name: string;
  color: string | null;
  /** Category type — expense (account-group) or a config-driven synthetic type. */
  categoryType: "expense" | "time" | "manual" | "derived" | "formula";
  /** The group's auto-match rule (editable in the category flyout). */
  match: { accountTypes?: string[]; numberPrefixes?: string[]; namePattern?: string };
  totalAmount: number;
  /** The formatted rate value in the category's rate format; null when this
   * category's own rate refuses (the refusal is recorded, never thrown). */
  rate: number | null; // the formatted rate value in the category's rate format
  /** Raw $/hr rate before formatting (totalAmount ÷ allocation base at Overall). */
  rawRate: number | null;
  /** Allocation settings applied to this category (rate engine). */
  allocationBase: AllocationBase;
  allocationMethod: AllocationMethod;
  rateFormat: RateFormat;
  includeInComposite: boolean;
  /** Locale- and currency-aware display string, or a percentage. */
  rateDisplay: string;
  accounts: BurdenAccount[];
  /** deptId → { amount, rate } (allocated where untagged); rate null when
   * this department scope refuses. */
  byDept: Record<string, { amount: number; rate: number | null }>;
  /**
   * Non-billable hours with no cost rate excluded from this category's cost
   * (exact string, set only on the native time category when greater than
   * zero) — unknown cost, never zero cost.
   */
  unratedHours?: string;
}

/** Additional non-expense category from config (manual/derived/formula). */
export interface CustomCategory {
  id: string;
  name: string;
  color: string | null;
  type: "manual" | "derived" | "formula";
  allocationBase: AllocationBase;
  rateFormat: RateFormat;
  includeInComposite: boolean;
  manualConfig?: { entryMode?: "fixed_total" | "by_dept" | "per_unit"; fixedTotal?: number | string; byDeptAmounts?: Record<string, number | string>; unitType?: AllocationBase; perUnitRate?: number | string };
  derivedConfig?: { sourceCategory?: string; percentage?: number | string; allocationBase?: AllocationBase | "same" };
  formulaConfig?: { formula?: string };
}

/** Per-category allocation overrides, keyed by category id. */
export interface CategorySettings {
  allocationBase?: AllocationBase;
  allocationMethod?: AllocationMethod;
  rateFormat?: RateFormat;
  includeInComposite?: boolean;
  allocationWeights?: Record<string, number>;
  allocationTiers?: { min?: number; max?: number; rate?: number | string }[];
}

/** A named engine profile with all tunables in one bundle. */
export interface TrueCostProfile {
  id: string;
  name: string;
  color?: string | null;
  compositeMethod: CompositeMethod;
  baseLaborRate: number | string; // cascading base
  fringeRate: number | string; // scenario fringe (0..1)
  categorySettings: Record<string, CategorySettings>;
  customCategories: CustomCategory[];
  baseOverrides: { squareFeet?: Record<string, number>; units?: Record<string, number>; custom?: Record<string, number> };
}

export interface TrueCostConfig {
  activeProfileId: string;
  profiles: TrueCostProfile[];
}

export interface MonthPoint {
  month: string;
  label: string;
  /** Exact monthly burden (decimal string); byCategory/byDept/rate stay numeric ratios. */
  burden: string;
  billedHours: number;
  rate: number;
  byCategory: Record<string, number>; // category key → rate
  byDept: Record<string, number>; // dept id → composite
}

export interface EmployeeRate {
  id: string;
  name: string;
  deptId: string | null;
  deptName: string;
  title: string;
  rate: number; // hours-weighted avg cost rate
  hours: number;
}

export interface TrueCostData {
  period: { from: string; to: string; label: string };
  departments: Dept[];
  /**
   * The composite-level refusal, when the composite cannot blend. The
   * Overall headline refusal wins the slot; otherwise the first
   * department-scope refusal in department order. Categories, departments
   * and the profile config still render — the refusal never hides the
   * screens that fix it.
   */
  compositeRefusal: TrueCostRefusal | null;
  kpis: {
    /** Overall composite; null when the Overall scope refuses (the refusal
     * then holds the Overall slot of `compositeRefusal`). */
    compositeRate: number | null;
    compositeRateChangePct: number | null; // vs immediately-preceding equal window
    totalOverhead: number;
    overheadAccounts: number;
    /** Actual applied burden; null when the mechanism carried no postings. */
    burdenApplied: number | null;
    /** applied − actual (negative = under-absorbed); null when unavailable. */
    gap: number | null;
    gapPerHour: number | null;
    absorptionPct: number | null;
    billedHours: number;
    totalHours: number;
    utilization: number;
    employeeCount: number;
  };
  categories: BurdenCategory[];
  unassigned: BurdenAccount[];
  /** Per-department and Overall composites; null wherever that scope refuses. */
  totals: { byDept: Record<string, number | null>; overall: number | null };
  labor: { employees: EmployeeRate[]; count: number; min: number; max: number; weighted: number; unratedHours: string };
  monthly: MonthPoint[];
  forecast: { month: string; label: string; rate: number }[];
  hasBurdenGL: boolean; // the configured application account carries applied postings
  /** Translated reason when absorption is unavailable; null when available. */
  absorptionUnavailable: string | null;
  /** Allocation base values () for the engine + UI. */
  bases: AllocationBaseBundle;
  /**
   * Publication readiness for the per-hour rate card. When `supported` is
   * false the Matrix preview still renders (display-only floats) but
   * `computeLiveOverheadRates` refuses with these blockers; `compositeExact`
   * is empty on every department.
   */
  ratePublication: { supported: boolean; blockers: OverheadPublishBlocker[] };
  /** Active engine config: composite method, per-category settings, custom categories, profiles. */
  config: {
    activeProfileId: string;
    compositeMethod: CompositeMethod;
    baseLaborRate: number | string;
    fringeRate: number | string;
    categorySettings: Record<string, CategorySettings>;
    profiles: { id: string; name: string; color?: string | null }[];
    customCategories: CustomCategory[];
  };
}

type TrueCostSqlNumeric = string | number | null;

interface EmployeeRateSqlRow {
  id: string;
  name: string;
  dept_id: string | null;
  dept_name: string;
  title: string;
  rate: TrueCostSqlNumeric;
  hours: TrueCostSqlNumeric;
  func: string | null;
  late: string | null;
  cost: TrueCostSqlNumeric;
  rated_hours: TrueCostSqlNumeric;
}

interface HoursSqlRow {
  department_id: string | null;
  month: string;
  func: string | null;
  late: string | null;
  billed_hours: TrueCostSqlNumeric;
  total_hours: TrueCostSqlNumeric;
  nonbill_cost: TrueCostSqlNumeric;
  unrated_hours: TrueCostSqlNumeric;
  unrated_billed_hours: TrueCostSqlNumeric;
  /** Exact decimal twins of the merged hour sums (rate-derivation input). */
  billed_hours_exact?: string;
  total_hours_exact?: string;
  unrated_hours_exact?: string;
}

/**
 * Translate one consolidated leg to presentation, skipping the rate lookup
 * for zero money so an empty window never demands coverage. Nonzero money
 * without coverage still fails closed in rateAt.
 */
function translateLeg(
  amount: string,
  func: string | null,
  date: string,
  rateAt: (func: string | null, date: string) => string,
): string {
  return Number(amount) === 0 ? "0" : mulDecimal(amount, rateAt(func, date));
}

interface DepartmentSqlRow {
  id: string;
  name: string;
}

interface BurdenAccountSqlRow {
  account_id: string;
  number: string | null;
  name: string;
  amount: TrueCostSqlNumeric;
  department_id: string | null;
  month: string;
  func: string | null;
  late: string | null;
}

interface PriorBurdenSqlRow {
  account_id: string;
  func: string | null;
  late: string | null;
  amount: TrueCostSqlNumeric;
  billed_hours: TrueCostSqlNumeric;
}

export const DEFAULT_PROFILE: TrueCostProfile = {
  id: "default",
  name: "Default",
  color: "#3b82f6",
  compositeMethod: "sum",
  // No assumed labor rate: empty means "derive from costed time, else refuse
  // when the composite method needs one". A previously-saved numeric default
  // is an explicit operator value, not an assumption.
  baseLaborRate: "",
  fringeRate: 0.25,
  categorySettings: {},
  customCategories: [],
  baseOverrides: {},
};

/** Load the True Cost engine config and resolve the active profile (). */
export async function loadTrueCostConfig(orgId: string): Promise<{ activeProfileId: string; profiles: TrueCostProfile[]; profile: TrueCostProfile }> {
  const r = await analyticsQuery(sql`
    select settings -> 'analytics' -> 'trueCost' as cfg from orgs where id = ${orgId}
  `);
  const raw = r.rows[0]?.cfg as Partial<TrueCostConfig> | null;
  const profiles: TrueCostProfile[] = Array.isArray(raw?.profiles) && raw!.profiles.length
    ? raw!.profiles.map((p) => ({ ...DEFAULT_PROFILE, ...p, categorySettings: p.categorySettings ?? {}, customCategories: p.customCategories ?? [], baseOverrides: p.baseOverrides ?? {} }))
    : [DEFAULT_PROFILE];
  const activeProfileId = raw?.activeProfileId && profiles.some((p) => p.id === raw!.activeProfileId) ? raw!.activeProfileId : profiles[0]!.id;
  const profile = profiles.find((p) => p.id === activeProfileId) ?? profiles[0]!;
  return { activeProfileId, profiles, profile };
}

export async function trueCostData(
  orgId: string,
  period: { from: string; to: string; label: string },
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  strings: TrueCostStrings = trueCostStrings(englishCatalogMessage, "en"),
): Promise<TrueCostData> {
  if (!(await isFeatureEnabled(orgId, "projects"))) throw new Error("projects feature is disabled")
  const ids = allowedSubsidiaryIds === null ? null : [...allowedSubsidiaryIds]
  const allowed = ids?.length ? sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `) : sql`null`
  const ledgerScope = sql`and e.status in ('posted', 'reversed') and e.book_id = ${statementBookExpr(orgId)}
    ${ids === null ? sql`` : sql`and l.subsidiary_id in (${allowed})`}`
  // Approved time only, on every labour leg: draft, submitted and rejected
  // hours are not worked reality — the same approved-only rule as
  // utilization, project profitability hours and the time drill-down. The
  // status gate is unconditional; only the subsidiary fence is optional.
  const timeScope = sql`and t.status = 'approved' ${ids === null ? sql`` : sql`and exists (
    select 1 from parties scope_employee
    left join projects scope_project on scope_project.id = t.project_id and scope_project.org_id = t.org_id
    where scope_employee.id = t.employee_party_id and scope_employee.org_id = t.org_id
      and coalesce(scope_project.subsidiary_id, scope_employee.subsidiary_id) in (${allowed})
  )`}`
  const { money } = await getMoneyFormatter(orgId)
  const { from, to } = period;
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  const priorFrom = new Date(start.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const priorTo = new Date(start.getTime() - 86_400_000).toISOString().slice(0, 10);

  const monthCount = Math.max(1, (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth()) + 1);

  // Classification owners resolve before any scan: the direct-labour
  // account set (rule plus pin) and the configured overhead application
  // account feed the SQL below, so no English name pattern remains.
  const [cfg, burdenGroups, poolGroups, appliedSettings] = await Promise.all([
    loadTrueCostConfig(orgId),
    resolveAccountGroups("burden", orgId),
    resolveAccountGroups("cost_pool", orgId),
    overheadApplicationSettings(orgId),
  ]);
  const directLaborIds = new Set(
    [...poolGroups.byAccount.entries()].filter(([, g]) => g.key === "direct_labor").map(([id]) => id),
  );
  const laborIdList = [...directLaborIds];
  const laborFilter = laborIdList.length > 0
    ? sql`l.account_id in (${sql.join(laborIdList.map((id) => sql`${id}::uuid`), sql`, `)})`
    : sql`1 = 0`;
  // With no configured application account the mechanism is absent: the
  // applied scan matches nothing and absorption reports unavailable.
  const appliedAccountId = appliedSettings.accountId;
  const appliedFilter = appliedAccountId
    ? sql`l.account_id = ${appliedAccountId}::uuid and e.origin = 'overhead_applied' and l.project_id is not null`
    : sql`1 = 0`;
  const [acctRows, hoursRows, empRows, priorRows, priorTimeRows, appliedRows, deptRows, baseRows, hcRows] = await Promise.all([
    // Expense account totals per account × department × month × functional —
    // journal legs arrive stamped in their line entity's functional and
    // translate to presentation before the burden math ever sees them.
    analyticsQuery(sql`
      select l.account_id, a.number, a.name, to_char(e.posting_date, 'YYYY-MM') as month,
        l.department_id, sub.base_currency as func, max(e.posting_date)::text as late,
        sum(l.amount) as amount
      from journal_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
      where l.org_id = ${orgId} ${ledgerScope}
        and a.type in ('expense', 'expense_other', 'expense_deferred')
        and a.is_summary = false
        and e.posting_date >= ${from} and e.posting_date <= ${to}
      group by 1, 2, 3, 4, 5, 6
    `),
    // Labour hours per department × month (billed = is_billable). Non-billable
    // labour cost (Σ hours × cost rate on non-billable time) is a native burden
    // category — the cost of paying people for unbilled time must be recovered
    // on billable hours (the unbilled-labour / time category).
    analyticsQuery(sql`
      select t.department_id, to_char(t.worked_on, 'YYYY-MM') as month,
        coalesce(t.cost_rate_currency, crs.base_currency, o.base_currency) as func,
        max(t.worked_on)::text as late,
        sum(t.hours) as total_hours,
        coalesce(sum(t.hours) filter (where t.is_billable), 0) as billed_hours,
        coalesce(sum(t.hours * coalesce(t.cost_rate, 0)) filter (where t.is_billable is not true), 0) as nonbill_cost,
        -- Approved time with no cost rate is NOT zero cost: its hours travel
        -- separately and surface by name, never folded into money as $0.
        coalesce(sum(t.hours) filter (where t.is_billable is not true and t.cost_rate is null), 0) as unrated_hours,
        coalesce(sum(t.hours) filter (where t.is_billable and t.cost_rate is null), 0) as unrated_billed_hours
      from time_entries t
      left join subsidiaries crs on crs.id = t.cost_rate_subsidiary_id and crs.org_id = t.org_id
      join orgs o on o.id = t.org_id
      where t.org_id = ${orgId} ${timeScope} and t.worked_on >= ${from} and t.worked_on <= ${to}
      group by 1, 2, 3
    `),
    // Per-employee weighted labour rate + dominant dept/labour class. Cost
    // legs arrive per (employee, functional) so the rate translates before
    // the division — a cross-currency average of raw rates is meaningless.
    (analyticsSection('true-cost', ["selling"]) ? analyticsQuery(sql`
      with per_emp as (
        select t.employee_party_id, coalesce(p.display_name, 'Unknown') as name,
          coalesce(t.cost_rate_currency, crs.base_currency, o.base_currency) as func,
          max(t.worked_on)::text as late,
          sum(t.hours) as hours,
          sum(coalesce(t.cost_rate, 0) * t.hours) as cost,
          sum(t.hours) filter (where t.cost_rate > 0) as rated_hours
        from time_entries t
        left join parties p on p.id = t.employee_party_id and p.org_id = t.org_id
        left join subsidiaries crs on crs.id = t.cost_rate_subsidiary_id and crs.org_id = t.org_id
        join orgs o on o.id = t.org_id
        where t.org_id = ${orgId} ${timeScope} and t.worked_on >= ${from} and t.worked_on <= ${to}
        group by 1, 2, 3
      ), dom_dept as (
        select distinct on (employee_party_id) employee_party_id, department_id
        from (select employee_party_id, department_id, sum(hours) h from time_entries t
              where t.org_id = ${orgId} ${timeScope} and worked_on >= ${from} and worked_on <= ${to} group by 1, 2) x
        order by employee_party_id, h desc
      ), dom_item as (
        select distinct on (x.employee_party_id) x.employee_party_id, i.name as title
        from (select employee_party_id, item_id, sum(hours) h from time_entries t
              where t.org_id = ${orgId} ${timeScope} and worked_on >= ${from} and worked_on <= ${to} group by 1, 2) x
        join items i on i.id = x.item_id and i.org_id = ${orgId}
        order by x.employee_party_id, x.h desc
      )
      select pe.employee_party_id as id, pe.name, pe.func, pe.late,
        pe.hours, pe.cost, pe.rated_hours,
        dd.department_id as dept_id, coalesce(d.name, '—') as dept_name, coalesce(di.title, '—') as title
      from per_emp pe
      left join dom_dept dd on dd.employee_party_id = pe.employee_party_id
      left join departments d on d.id = dd.department_id and d.org_id = ${orgId}
      left join dom_item di on di.employee_party_id = pe.employee_party_id
      where pe.hours > 0
    `) : Promise.resolve({rows:[]})),
    // Prior equal window: per-account expense (classified below) + billed hours.
    (analyticsSection('true-cost', ["absorption","selling"]) ? analyticsQuery(sql`
      select l.account_id, sub.base_currency as func, max(e.posting_date)::text as late,
        sum(l.amount) as amount,
        (select coalesce(sum(t.hours) filter (where t.is_billable), 0) from time_entries t
          where t.org_id = ${orgId} ${timeScope} and t.worked_on >= ${priorFrom} and t.worked_on <= ${priorTo}) as billed_hours
      from journal_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
      where l.org_id = ${orgId} ${ledgerScope} and a.type in ('expense', 'expense_other', 'expense_deferred')
        and a.is_summary = false and e.posting_date >= ${priorFrom} and e.posting_date <= ${priorTo}
      group by 1, 2
    `) : Promise.resolve({rows:[]})),
    // Prior-window non-billable labour cost per functional: the scalar
    // subselect above cannot carry legs, so it travels on its own query.
    (analyticsSection('true-cost', ["absorption","selling"]) ? analyticsQuery(sql`
      select coalesce(t.cost_rate_currency, crs.base_currency, o.base_currency) as func,
        max(t.worked_on)::text as late,
        coalesce(sum(t.hours * coalesce(t.cost_rate, 0)) filter (where t.is_billable is not true), 0) as nonbill_cost
      from time_entries t
      left join subsidiaries crs on crs.id = t.cost_rate_subsidiary_id and crs.org_id = t.org_id
      join orgs o on o.id = t.org_id
      where t.org_id = ${orgId} ${timeScope} and t.worked_on >= ${priorFrom} and t.worked_on <= ${priorTo}
      group by 1
    `) : Promise.resolve({rows:[]})),
    // Applied burden: project-tagged legs on the configured application
    // account with origin 'overhead_applied' — the same legs
    // listOverheadApplications sums. The pair's offsetting untagged leg nets
    // to zero on the same account, so it is excluded by the project tag.
    analyticsQuery(sql`
      select sub.base_currency as func, max(e.posting_date)::text as late,
        coalesce(sum(l.amount), 0) as applied, count(*) as lines
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
      where l.org_id = ${orgId} ${ledgerScope} and ${appliedFilter}
        and e.posting_date >= ${from} and e.posting_date <= ${to}
      group by 1
    `),
    analyticsQuery(sql`select id, name from departments where org_id = ${orgId} order by name`),
    // Allocation bases by department (): labour $,
    // headcount, revenue, direct cost. Hours come from the time legs above.
    // One grouped pass per source instead of a correlated GL subquery per
    // department per basis — that shape re-scanned the window's ledger three
    // times for every department on the page.
    // No entry join: the line carries its own posting date. And the labour
    // classification is the configured cost_pool / direct_labor account set
    // (rule plus pin) resolved once above — never an account-name pattern.
    analyticsQuery(sql`
      with gl as (
        select l.department_id, sub.base_currency as func, max(e.posting_date)::text as late,
               coalesce(sum(l.amount) filter (where ${laborFilter}), 0) as labor_dollars,
               coalesce(-sum(l.amount) filter (where l.account_id in (
                 select id from accounts where org_id = ${orgId}
                   and type in ('income','income_other'))), 0) as revenue,
               coalesce(sum(l.amount) filter (where l.account_id in (
                 select id from accounts where org_id = ${orgId} and type = 'cogs')), 0) as direct_cost
          from journal_lines l
          join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
          left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
         where l.org_id = ${orgId} ${ledgerScope} and l.department_id is not null
           and l.posting_date >= ${from} and l.posting_date <= ${to}
         group by l.department_id, sub.base_currency
      )
      select d.id as dept_id, gl.func as func, max(gl.late) as late,
             coalesce(max(gl.labor_dollars), 0) as labor_dollars,
             coalesce(max(gl.revenue), 0) as revenue,
             coalesce(max(gl.direct_cost), 0) as direct_cost
        from departments d
        left join gl on gl.department_id = d.id
       where d.org_id = ${orgId}
       group by d.id, gl.func
    `),
    // Headcount aggregates once per department, outside any currency
    // grouping: a department with GL activity in N currencies counts its
    // people once, not once per currency.
    db.execute(sql`
      select t.department_id, count(distinct t.employee_party_id) as headcount
        from time_entries t
       where t.org_id = ${orgId} ${timeScope} and t.department_id is not null
         and t.worked_on >= ${from} and t.worked_on <= ${to}
       group by t.department_id
    `),
  ]);
  const profile = cfg.profile;

  // ---- presentation translation ---------------------------------------------
  // Every money-bearing scan above arrives per (group, functional). One
  // shared flow context translates each leg at its latest date; the merges
  // below restore the exact row shapes the burden math expects. Hours,
  // headcounts and line counts are currency-blind and re-add exactly.
  const acctLegs = acctRows.rows as unknown as BurdenAccountSqlRow[];
  const hourLegs = hoursRows.rows as unknown as HoursSqlRow[];
  const empLegs = empRows.rows as unknown as EmployeeRateSqlRow[];
  const priorLegs = priorRows.rows as unknown as PriorBurdenSqlRow[];
  const priorTimeLegs = priorTimeRows.rows as unknown as { func: string | null; late: string | null; nonbill_cost: TrueCostSqlNumeric }[];
  const appliedLegs = appliedRows.rows as unknown as { func: string | null; late: string | null; applied: TrueCostSqlNumeric; lines: string | number }[];
  const baseLegs = baseRows.rows as unknown as { dept_id: string; func: string | null; late: string | null; labor_dollars: TrueCostSqlNumeric; revenue: TrueCostSqlNumeric; direct_cost: TrueCostSqlNumeric }[];
  const headcountRows = hcRows.rows as unknown as { department_id: string; headcount: string | number }[];
  const tcCtx = await flowRates(orgId, [
    ...acctLegs.map((r) => ({ func: r.func ?? null, date: String(r.late ?? to).slice(0, 10) })),
    ...hourLegs.map((r) => ({ func: r.func ?? null, date: String(r.late ?? to).slice(0, 10) })),
    ...empLegs.map((r) => ({ func: r.func ?? null, date: String(r.late ?? to).slice(0, 10) })),
    ...priorLegs.map((r) => ({ func: r.func ?? null, date: String(r.late ?? priorTo).slice(0, 10) })),
    ...priorTimeLegs.map((r) => ({ func: r.func ?? null, date: String(r.late ?? priorTo).slice(0, 10) })),
    ...appliedLegs.map((r) => ({ func: r.func ?? null, date: String(r.late ?? to).slice(0, 10) })),
    ...baseLegs.map((r) => ({ func: r.func ?? null, date: String(r.late ?? to).slice(0, 10) })),
  ]);
  const tcRateAt = (func: string | null, date: string) => tcCtx.rateAt(func, date);
  // Expense legs merged back to (account, month, department) presentation rows.
  const acctTranslated: BurdenAccountSqlRow[] = [];
  {
    const byKey = new Map<string, BurdenAccountSqlRow & { amount: string }>();
    for (const r of acctLegs) {
      const key = JSON.stringify([r.account_id, r.month, r.department_id]);
      const prev = byKey.get(key) ?? { ...r, amount: "0" };
      prev.amount = add(String(prev.amount), translateLeg(String(r.amount ?? 0), r.func ?? null, String(r.late ?? to).slice(0, 10), tcRateAt));
      byKey.set(key, prev);
    }
    for (const v of byKey.values()) acctTranslated.push(v);
  }
  // Time legs merged back to (department, month) rows; hours re-added. The
  // exact twins accumulate the raw numerics without crossing a float, so the
  // rate engine divides the same hours the display sums.
  const hourTranslated: HoursSqlRow[] = [];
  // Unrated hours merge as hours (currency-blind, exact) alongside — they
  // are reported by name and never priced at zero.
  const unratedHoursByDept = new Map<string, string>();
  let unratedHoursExact = "0.0000";
  {
    const byKey = new Map<string, HoursSqlRow & { billed: number; total: number; nonbill: string; billedExact: string; totalExact: string; unratedExact: string }>();
    for (const r of hourLegs) {
      const key = JSON.stringify([r.department_id, r.month]);
      const prev = byKey.get(key) ?? { ...r, billed: 0, total: 0, nonbill: "0", billedExact: "0.0000", totalExact: "0.0000", unratedExact: "0.0000" };
      prev.billed += Number(r.billed_hours ?? 0);
      prev.total += Number(r.total_hours ?? 0);
      prev.billedExact = add(prev.billedExact, normalizeMoney(String(r.billed_hours ?? 0)));
      prev.totalExact = add(prev.totalExact, normalizeMoney(String(r.total_hours ?? 0)));
      prev.unratedExact = add(prev.unratedExact, normalizeMoney(String(r.unrated_hours ?? 0)));
      prev.nonbill = add(String(prev.nonbill), translateLeg(String(r.nonbill_cost ?? 0), r.func ?? null, String(r.late ?? to).slice(0, 10), tcRateAt));
      byKey.set(key, prev);
    }
    for (const v of byKey.values()) {
      hourTranslated.push({ ...v, billed_hours: v.billed, total_hours: v.total, nonbill_cost: v.nonbill, billed_hours_exact: v.billedExact, total_hours_exact: v.totalExact, unrated_hours_exact: v.unratedExact });
    }
  }
  for (const r of hourTranslated) {
    const dept = r.department_id ?? "none";
    const unrated = r.unrated_hours_exact ?? "0.0000";
    if (cmp(unrated, "0") === 0) continue;
    unratedHoursExact = add(unratedHoursExact, unrated);
    if (dept !== "none") unratedHoursByDept.set(dept, add(unratedHoursByDept.get(dept) ?? "0.0000", unrated));
  }
  // Employee legs merged to one presentation row each: the rate is
  // translated cost over rated hours, never an average of raw rates.
  const empTranslated: EmployeeRateSqlRow[] = [];
  // Exact per-employee period hours (dominant department alongside) for the
  // annual-FTE-hours weighting below.
  const empHoursExact = new Map<string, { deptId: string | null; hours: string }>();
  // Exact per-department labor cost ÷ rated hours for the cascading composite
  // base (mirrors the Overall hours-weighted average per department).
  const deptLaborExact = new Map<string, { cost: string; rated: string }>();
  let overallLaborCostExact = "0.0000";
  let overallLaborRatedExact = "0.0000";
  {
    const byId = new Map<string, { base: EmployeeRateSqlRow; hours: number; hoursExact: string; cost: string; rated: number; ratedExact: string }>();
    for (const r of empLegs) {
      const prev = byId.get(r.id) ?? { base: r, hours: 0, hoursExact: "0.0000", cost: "0", rated: 0, ratedExact: "0.0000" };
      prev.hours += Number(r.hours ?? 0);
      prev.hoursExact = add(prev.hoursExact, normalizeMoney(String(r.hours ?? 0)));
      prev.rated += Number(r.rated_hours ?? 0);
      prev.ratedExact = add(prev.ratedExact, normalizeMoney(String(r.rated_hours ?? 0)));
      prev.cost = add(String(prev.cost), translateLeg(String(r.cost ?? 0), r.func ?? null, String(r.late ?? to).slice(0, 10), tcRateAt));
      byId.set(r.id, prev);
    }
    for (const v of byId.values()) {
      overallLaborCostExact = add(overallLaborCostExact, v.cost);
      overallLaborRatedExact = add(overallLaborRatedExact, v.ratedExact);
      empHoursExact.set(v.base.id, { deptId: v.base.dept_id, hours: v.hoursExact });
      const deptId = v.base.dept_id;
      if (deptId) {
        const prev = deptLaborExact.get(deptId) ?? { cost: "0.0000", rated: "0.0000" };
        prev.cost = add(prev.cost, v.cost);
        prev.rated = add(prev.rated, v.ratedExact);
        deptLaborExact.set(deptId, prev);
      }
    }
    for (const v of byId.values()) {
      empTranslated.push({
        ...v.base,
        hours: v.hours,
        cost: v.cost,
        rated_hours: v.rated,
        rate: v.rated > 0 ? toChartNumber(div(v.cost, v.ratedExact)) : 0,
      });
    }
  }
  // ---- annual FTE hours per scope -------------------------------------------
  // A per-FTE display multiplies an hourly rate by full-time annual hours.
  // The divisor is measured, never assumed: per employee, the work schedule
  // in force annualized from its own cycle, else the winning
  // labor_cost_rates.annual_hours. Each scope takes the hours-weighted exact
  // mean over its resolved employees; with nothing resolved the per-FTE
  // category refuses by name below.
  const annualHoursByDept = new Map<string, string>();
  let overallAnnualHours: string | null = null;
  {
    const empIds = [...empHoursExact.keys()];
    if (empIds.length > 0) {
      const [rateAnnual, roleRows, schedules] = await Promise.all([
        resolveAnnualHoursMany(orgId, empIds, to),
        db.execute<{ party_id: string; job_title: string | null; trade_id: string | null; department_id: string | null; subsidiary_id: string | null }>(sql`
          select distinct on (er.party_id) er.party_id, er.job_title, er.trade_id, er.department_id, p.subsidiary_id
            from employee_roles er
            join parties p on p.id = er.party_id and p.org_id = er.org_id
           where er.org_id = ${orgId} and er.party_id in (${sql.join(empIds.map((id) => sql`${id}::uuid`), sql`, `)})`),
        loadWorkSchedules(db, orgId, allowedSubsidiaryIds),
      ]);
      const keysByEmp = new Map(roleRows.rows.map((r) => [r.party_id, r]));
      const annualByEmp = new Map<string, string>();
      for (const id of empIds) {
        const keys = keysByEmp.get(id);
        const schedule = pickWorkSchedule(schedules, {
          employeePartyId: id,
          jobTitle: keys?.job_title ?? null,
          tradeId: keys?.trade_id ?? null,
          departmentId: keys?.department_id ?? null,
          subsidiaryId: keys?.subsidiary_id ?? null,
        }, to);
        // Annualize from the schedule's own cycle: its hours repeat every
        // cycleDays days, so a common year carries 365 ÷ cycleDays repeats —
        // never a bare ×52, which assumes a 7-day cycle and a 364-day year.
        // A schedule with varying hours annualizes to nothing and refuses.
        // The cycle total sums the resolved day hours exactly (the same sum
        // the payroll cycle helper owns; only the public weekly figure is
        // exported, so the loader totals its own divisor here).
        const cycleHours = schedule && schedule.pattern === "cycle"
          ? schedule.days.reduce((sum, day) => add(sum, day.hours), "0.0000")
          : null;
        const cycleDays = schedule?.cycleDays ?? null;
        const fromSchedule = cycleHours === null || cycleDays === null || cycleDays <= 0 || cmp(cycleHours, "0") <= 0
          ? null
          : div(mulDecimal(cycleHours, "365"), String(cycleDays));
        const annual = fromSchedule !== null && cmp(fromSchedule, "0") > 0
          ? fromSchedule
          : (rateAnnual.get(id) ?? null);
        if (annual !== null && cmp(annual, "0") > 0) annualByEmp.set(id, annual);
      }
      // Hours-weighted exact mean per scope, in bigint units throughout.
      const meanAnnual = (ids: string[]): string | null => {
        let numerator = 0n;
        let denominator = 0n;
        for (const id of ids) {
          const annual = annualByEmp.get(id);
          const hours = empHoursExact.get(id)?.hours ?? "0.0000";
          if (annual === undefined || cmp(hours, "0") <= 0) continue;
          numerator += toUnits(annual) * toUnits(hours);
          denominator += toUnits(hours);
        }
        return denominator > 0n ? fromUnits(roundDiv(numerator, denominator)) : null;
      };
      overallAnnualHours = meanAnnual(empIds);
      const deptIds = new Set<string>();
      for (const { deptId } of empHoursExact.values()) if (deptId) deptIds.add(deptId);
      for (const d of deptIds) {
        const deptEmpIds = empIds.filter((id) => empHoursExact.get(id)?.deptId === d);
        const mean = meanAnnual(deptEmpIds);
        if (mean !== null) annualHoursByDept.set(d, mean);
      }
    }
  }
  // Prior-window expense merged per account; prior non-billable cost summed.
  const priorTranslated: PriorBurdenSqlRow[] = [];
  let priorBilledHours = 0;
  {
    const byAccount = new Map<string, PriorBurdenSqlRow & { amount: string }>();
    for (const r of priorLegs) {
      priorBilledHours = Number(r.billed_hours ?? 0);
      const prev = byAccount.get(r.account_id) ?? { ...r, amount: "0" };
      prev.amount = add(String(prev.amount), translateLeg(String(r.amount ?? 0), r.func ?? null, String(r.late ?? priorTo).slice(0, 10), tcRateAt));
      byAccount.set(r.account_id, prev);
    }
    for (const v of byAccount.values()) priorTranslated.push(v);
  }
  let priorNonbillCost = "0";
  for (const r of priorTimeLegs) {
    priorNonbillCost = add(priorNonbillCost, translateLeg(String(r.nonbill_cost ?? 0), r.func ?? null, String(r.late ?? priorTo).slice(0, 10), tcRateAt));
  }
  // Burden-applied mechanism merged to one presentation total; lines re-added.
  let appliedTotal = "0";
  let appliedLines = 0;
  for (const r of appliedLegs) {
    appliedLines += Number(r.lines ?? 0);
    appliedTotal = add(appliedTotal, translateLeg(String(r.applied ?? 0), r.func ?? null, String(r.late ?? to).slice(0, 10), tcRateAt));
  }
  // Allocation bases merged per department; headcount joins once per
  // department from its own currency-blind scan (never summed per leg).
  type BaseCell = { labor_dollars: string; headcount: number; revenue: string; direct_cost: string };
  const baseTranslated = new Map<string, BaseCell>();
  for (const r of baseLegs) {
    const prev = baseTranslated.get(r.dept_id) ?? { labor_dollars: "0", headcount: 0, revenue: "0", direct_cost: "0" };
    const date = String(r.late ?? to).slice(0, 10);
    prev.labor_dollars = add(prev.labor_dollars, translateLeg(String(r.labor_dollars ?? 0), r.func ?? null, date, tcRateAt));
    prev.revenue = add(prev.revenue, translateLeg(String(r.revenue ?? 0), r.func ?? null, date, tcRateAt));
    prev.direct_cost = add(prev.direct_cost, translateLeg(String(r.direct_cost ?? 0), r.func ?? null, date, tcRateAt));
    baseTranslated.set(r.dept_id, prev);
  }
  for (const h of headcountRows) {
    const prev = baseTranslated.get(h.department_id) ?? { labor_dollars: "0", headcount: 0, revenue: "0", direct_cost: "0" };
    prev.headcount = Number(h.headcount ?? 0);
    baseTranslated.set(h.department_id, prev);
  }

  // ---- hours by department --------------------------------------------------
  const deptHours = new Map<string, { billed: number; total: number }>();
  const monthHours = new Map<string, { billed: number; total: number }>();
  const deptMonthBilled = new Map<string, number>(); // `${dept}|${month}`
  // Non-billable labour cost by month (monthly rate ratios only; exact money
  // resolves in the twin loop below).
  const nonbillCostByMonth = new Map<string, number>();
  const nonbillCostByDeptMonth = new Map<string, number>(); // `${dept}|${month}`
  let billedHours = 0, totalHours = 0;
  // Exact twins of the billed/total hour aggregates: the rate engine's
  // allocation denominators, never a float.
  const deptBilledExact = new Map<string, string>();
  const deptTotalExact = new Map<string, string>();
  let billedHoursExact = "0.0000";
  let totalHoursExact = "0.0000";
  for (const r of hourTranslated) {
    const dept = r.department_id ?? "none";
    const billed = Number(r.billed_hours ?? 0);
    const total = Number(r.total_hours ?? 0);
    const nonbill = toChartNumber(String(r.nonbill_cost ?? 0));
    const billedExact = r.billed_hours_exact ?? normalizeMoney(String(r.billed_hours ?? 0));
    const totalExact = r.total_hours_exact ?? normalizeMoney(String(r.total_hours ?? 0));
    deptBilledExact.set(dept, add(deptBilledExact.get(dept) ?? "0.0000", billedExact));
    deptTotalExact.set(dept, add(deptTotalExact.get(dept) ?? "0.0000", totalExact));
    billedHoursExact = add(billedHoursExact, billedExact);
    totalHoursExact = add(totalHoursExact, totalExact);
    const dh = deptHours.get(dept) ?? { billed: 0, total: 0 };
    dh.billed += billed; dh.total += total;
    deptHours.set(dept, dh);
    const mh = monthHours.get(r.month) ?? { billed: 0, total: 0 };
    mh.billed += billed; mh.total += total;
    monthHours.set(r.month, mh);
    deptMonthBilled.set(`${dept}|${r.month}`, (deptMonthBilled.get(`${dept}|${r.month}`) ?? 0) + billed);
    nonbillCostByMonth.set(r.month, (nonbillCostByMonth.get(r.month) ?? 0) + nonbill);
    nonbillCostByDeptMonth.set(`${dept}|${r.month}`, (nonbillCostByDeptMonth.get(`${dept}|${r.month}`) ?? 0) + nonbill);
    billedHours += billed; totalHours += total;
  }

  // Burden centres = departments with BILLED hours (a dept that bills nothing
  // has no rate denominator; its tagged burden is reallocated like untagged).
  const departmentsBase = (deptRows.rows as unknown as DepartmentSqlRow[])
    .map((d) => ({ id: d.id as string, name: d.name as string, hours: deptHours.get(d.id) ?? { billed: 0, total: 0 } }))
    .filter((d) => d.hours.billed > 0)
    .sort((a, b) => b.hours.billed - a.hours.billed);
  const billedShare = new Map(departmentsBase.map((d) => [d.id, billedHours > 0 ? d.hours.billed / billedHours : 0]));

  // ---- allocation-base bundle () -----------------
  const deptIds = departmentsBase.map((d) => d.id);
  const baseMap = baseTranslated;
  const sumBase = (field: keyof BaseCell) => deptIds.reduce((s, id) => s + Number(baseMap.get(id)?.[field] ?? 0), 0);
  const byDeptBase = (field: keyof BaseCell): Record<string, number> =>
    Object.fromEntries(deptIds.map((id) => [id, Number(baseMap.get(id)?.[field] ?? 0)]));
  const bases: AllocationBaseBundle = {
    hours: {
      total: totalHours,
      totalBilled: billedHours,
      byDept: Object.fromEntries(departmentsBase.map((d) => [d.id, { total: d.hours.total, billed: d.hours.billed }])),
    },
    laborDollars: { total: sumBase("labor_dollars"), byDept: byDeptBase("labor_dollars") },
    headcount: { total: sumBase("headcount"), byDept: byDeptBase("headcount") },
    revenue: { total: sumBase("revenue"), byDept: byDeptBase("revenue") },
    directCost: { total: sumBase("direct_cost"), byDept: byDeptBase("direct_cost") },
    squareFeet: { total: Object.values(profile.baseOverrides.squareFeet ?? {}).reduce((s, v) => s + Number(v || 0), 0), byDept: profile.baseOverrides.squareFeet ?? {} },
    units: { total: Object.values(profile.baseOverrides.units ?? {}).reduce((s, v) => s + Number(v || 0), 0), byDept: profile.baseOverrides.units ?? {} },
    custom: { total: Object.values(profile.baseOverrides.custom ?? {}).reduce((s, v) => s + Number(v || 0), 0), byDept: profile.baseOverrides.custom ?? {} },
    monthCount,
  };


  const settingsOf = (id: string): CategorySettings => profile.categorySettings[id] ?? {};

  /**
   * Exact per-department allocation-base values for one base type. Same scope
   * as the float bundle (burden centres only): hours from the exact twins,
   * money bases from the translated legs, headcount as integers, and config
   * overrides quantized exactly (a no-op for ordinary decimals).
   */
  const baseExactFor = (base: AllocationBase): Record<string, string> => {
    const byDept: Record<string, string> = {};
    for (const d of departmentsBase) {
      switch (base) {
        case "billed_hours": byDept[d.id] = deptBilledExact.get(d.id) ?? "0.0000"; break;
        case "total_hours": byDept[d.id] = deptTotalExact.get(d.id) ?? "0.0000"; break;
        case "labor_dollars": byDept[d.id] = baseTranslated.get(d.id)?.labor_dollars ?? "0.0000"; break;
        case "headcount": byDept[d.id] = String(baseTranslated.get(d.id)?.headcount ?? 0); break;
        case "revenue": byDept[d.id] = baseTranslated.get(d.id)?.revenue ?? "0.0000"; break;
        case "direct_cost": byDept[d.id] = baseTranslated.get(d.id)?.direct_cost ?? "0.0000"; break;
        case "square_feet": byDept[d.id] = quantizeOverheadMoney(profile.baseOverrides.squareFeet?.[d.id] ?? 0); break;
        case "units": byDept[d.id] = quantizeOverheadMoney(profile.baseOverrides.units?.[d.id] ?? 0); break;
        case "custom": byDept[d.id] = quantizeOverheadMoney(profile.baseOverrides.custom?.[d.id] ?? 0); break;
      }
    }
    return byDept;
  };

  /**
   * Distribution shares for the category's OWN allocation base — one base
   * per category for both the monthly float spread and the exact untagged
   * attribution, so untagged expense never defaults to billed hours. Cached
   * per base; burden-centre scope matches baseExactFor.
   */
  const shareCache = new Map<AllocationBase, Map<string, number>>();
  const sharesForBase = (base: AllocationBase): Map<string, number> => {
    const cached = shareCache.get(base);
    if (cached) return cached;
    const exact = baseExactFor(base);
    let total = 0;
    const nums = new Map<string, number>();
    for (const d of departmentsBase) {
      const v = Number(exact[d.id] ?? 0);
      nums.set(d.id, v);
      total += v;
    }
    const shares = new Map<string, number>();
    for (const [id, v] of nums) shares.set(id, total > 0 ? v / total : 0);
    shareCache.set(base, shares);
    return shares;
  };

  // ---- classify expense into burden categories --------------------------------
  // Direct labour is the same configured cost_pool / direct_labor set that
  // feeds the labour-dollars allocation base above: one classification.
  const directLabor = directLaborIds;

  interface CatAgg {
    id: string; key: string; name: string; color: string | null;
    /** Exact category total (decimal string). */
    total: string;
    accounts: Map<string, BurdenAccount>;
    /** Tagged-department exact amounts; untagged accumulates separately. */
    byDeptTaggedExact: Map<string, string>;
    untaggedExact: string;
    byMonth: Map<string, number>;
  }
  const cats = new Map<string, CatAgg>();
  for (const g of burdenGroups.groups) {
    cats.set(g.id, { id: g.id, key: g.key, name: g.name, color: g.color, total: "0.0000", accounts: new Map(), byDeptTaggedExact: new Map(), untaggedExact: "0.0000", byMonth: new Map() });
  }
  const unassignedMap = new Map<string, BurdenAccount>();
  const monthBurden = new Map<string, string>();
  const monthCatRate = new Map<string, Map<string, number>>(); // month → cat key → amount
  const monthDeptBurden = new Map<string, Map<string, number>>(); // month → dept → amount

  for (const r of acctTranslated) {
    if (directLabor.has(r.account_id)) continue; // direct labour is not burden
    const amount = toChartNumber(String(r.amount ?? 0));
    if (amount === 0) continue;
    // Exact twin: translated legs already sum in money strings, so this
    // validation is a no-op pass-through that fails closed on corruption.
    const amountExact = normalizeMoney(String(r.amount ?? 0));
    const group = burdenGroups.byAccount.get(r.account_id);

    if (!group) {
      const u = unassignedMap.get(r.account_id) ?? {
        id: r.account_id, number: r.number, name: r.name, amount: "0.0000",
        pinned: false, deptAmounts: {} as Record<string, string>, untaggedAmount: "0.0000",
      };
      u.amount = add(u.amount, amountExact);
      if (r.department_id && billedShare.has(r.department_id)) {
        u.deptAmounts[r.department_id] = add(u.deptAmounts[r.department_id] ?? "0.0000", amountExact);
      } else {
        u.untaggedAmount = add(u.untaggedAmount, amountExact);
      }
      unassignedMap.set(r.account_id, u);
      continue;
    }
    const cat = cats.get(group.groupId);
    if (!cat) continue;
    cat.total = add(cat.total, amountExact);
    const acct = cat.accounts.get(r.account_id) ?? {
      id: r.account_id, number: r.number, name: r.name, amount: "0.0000",
      pinned: burdenGroups.pinned.has(r.account_id), deptAmounts: {} as Record<string, string>, untaggedAmount: "0.0000",
    };
    acct.amount = add(acct.amount, amountExact);
    if (r.department_id && billedShare.has(r.department_id)) {
      acct.deptAmounts[r.department_id] = add(acct.deptAmounts[r.department_id] ?? "0.0000", amountExact);
    } else {
      acct.untaggedAmount = add(acct.untaggedAmount, amountExact);
    }
    cat.accounts.set(r.account_id, acct);
    cat.byMonth.set(r.month, (cat.byMonth.get(r.month) ?? 0) + amount);
    monthBurden.set(r.month, add(monthBurden.get(r.month) ?? "0.0000", amountExact));
    if (!monthCatRate.has(r.month)) monthCatRate.set(r.month, new Map());
    monthCatRate.get(r.month)!.set(cat.key, (monthCatRate.get(r.month)!.get(cat.key) ?? 0) + amount);

    // Department attribution: tagged stays; untagged follows the category's
    // own allocation base. Exact per-department amounts resolve once below
    // (splitUntaggedExact); the float spread here feeds only monthly rate
    // ratios, never money totals.
    const spread = (deptId: string, amt: number) => {
      if (!monthDeptBurden.has(r.month)) monthDeptBurden.set(r.month, new Map());
      const md = monthDeptBurden.get(r.month)!;
      md.set(deptId, (md.get(deptId) ?? 0) + amt);
    };
    const catBase = settingsOf(group.groupId)?.allocationBase ?? "billed_hours";
    const catShares = sharesForBase(catBase);
    if (r.department_id && billedShare.has(r.department_id)) {
      spread(r.department_id, amount);
      cat.byDeptTaggedExact.set(r.department_id, add(cat.byDeptTaggedExact.get(r.department_id) ?? "0.0000", amountExact));
    } else {
      for (const d of departmentsBase) spread(d.id, amount * (catShares.get(d.id) ?? 0));
      // Exact untagged attribution happens once below (splitUntaggedExact):
      // per-row float shares stay display-only so rounding compounds once.
      cat.untaggedExact = add(cat.untaggedExact, amountExact);
    }
  }

  /**
   * Split one category's untagged exact total across burden centres by the
   * category's own allocation base — the exact twin of the per-row float
   * spread above. Each department's share is one exact proportional
   * allocation (mulRatio, halves away), so the published rate compounds
   * rounding exactly once.
   */
  const splitUntaggedExact = (tagged: Map<string, string>, untagged: string, base: AllocationBase): Map<string, string> => {
    const out = new Map<string, string>();
    const exact = baseExactFor(base);
    const entries = departmentsBase.map((d) => ({ id: d.id, units: toUnits(exact[d.id] ?? "0.0000") }));
    const totalUnits = entries.reduce((sum, e) => sum + e.units, 0n);
    for (const e of entries) {
      out.set(e.id, add(tagged.get(e.id) ?? "0.0000", totalUnits === 0n ? "0.0000" : mulRatio(untagged, e.units, totalUnits)));
    }
    return out;
  };

  // ---- native non-billable time category ---------------------------------------
  // Distribute non-billable labour cost across burden centres (tagged dept kept,
  // untagged/no-billed-hours allocated by billed-hours share) and fold it into
  // the monthly burden series so trends, forecast and absorption all include it.
  const TIME_ID = "__nonbillable_time__";
  const TIME_KEY = "nonbillable_time";
  // Exact twin of the loop above, partitioned identically: non-billable legs
  // already merge in money strings, so the engine input never sees a float.
  const timeTaggedExact = new Map<string, string>();
  let timeUntaggedExact = "0.0000";
  const timeExactByMonth = new Map<string, string>();
  for (const r of hourTranslated) {
    const costExact = normalizeMoney(String(r.nonbill_cost ?? 0));
    if (costExact === "0.0000") continue;
    const dept = r.department_id ?? "none";
    timeExactByMonth.set(r.month, add(timeExactByMonth.get(r.month) ?? "0.0000", costExact));
    if (dept !== "none" && billedShare.has(dept)) {
      timeTaggedExact.set(dept, add(timeTaggedExact.get(dept) ?? "0.0000", costExact));
    } else {
      timeUntaggedExact = add(timeUntaggedExact, costExact);
    }
  }
  const timeBase = settingsOf(TIME_ID)?.allocationBase ?? "billed_hours";
  const timeExpenseExactByDept = splitUntaggedExact(timeTaggedExact, timeUntaggedExact, timeBase);
  let timeTotalExact = timeUntaggedExact;
  for (const v of timeTaggedExact.values()) timeTotalExact = add(timeTotalExact, v);
  for (const [month, costExact] of timeExactByMonth) {
    monthBurden.set(month, add(monthBurden.get(month) ?? "0.0000", costExact));
  }
  for (const [month, cost] of nonbillCostByMonth) {
    if (cost === 0) continue;
    if (!monthCatRate.has(month)) monthCatRate.set(month, new Map());
    monthCatRate.get(month)!.set(TIME_KEY, (monthCatRate.get(month)!.get(TIME_KEY) ?? 0) + cost);
  }
  for (const [key, cost] of nonbillCostByDeptMonth) {
    if (cost === 0) continue;
    const sep = key.lastIndexOf("|");
    const dept = key.slice(0, sep);
    const month = key.slice(sep + 1);
    if (!monthDeptBurden.has(month)) monthDeptBurden.set(month, new Map());
    const md = monthDeptBurden.get(month)!;
    if (dept !== "none" && billedShare.has(dept)) md.set(dept, (md.get(dept) ?? 0) + cost);
    else {
      const timeShares = sharesForBase(timeBase);
      for (const d of departmentsBase) md.set(d.id, (md.get(d.id) ?? 0) + cost * (timeShares.get(d.id) ?? 0));
    }
  }

  const totalOverheadExact = [...cats.values()].reduce((total, category) => add(total, category.total), timeTotalExact);
  const totalOverhead = toChartNumber(totalOverheadExact);

  // Preview and publication share exact category rates; non-hourly units
  // remain explicitly blocked from the hourly publication card.
  const exactRatesByCat = new Map<string, { rates: Record<string, string | null>;
      overall: string | null;
      expenses: Record<string, string> }>();

  // Refusals recorded while building categories, keyed by scope. A refused
  // rate is data, never an exception: the category still renders with its
  // expense, and the composite decides from these maps whether it can blend.
  const overallRefusals = new Map<string, TrueCostRefusal>();
  const deptRefusals = new Map<string, Map<string, TrueCostRefusal>>();
  const recordRefusal = (catId: string, deptId: string | null, refusal: TrueCostRefusal): null => {
    if (deptId === null) {
      if (!overallRefusals.has(catId)) overallRefusals.set(catId, refusal);
    } else {
      let byDept = deptRefusals.get(catId);
      if (!byDept) { byDept = new Map(); deptRefusals.set(catId, byDept); }
      if (!byDept.has(deptId)) byDept.set(deptId, refusal);
    }
    return null;
  };
  const deptNameOf = (deptId: string): string => departmentsBase.find((d) => d.id === deptId)?.name ?? deptId;

  // Apply the rate engine to one category's expense-by-dept: allocation
  // base × method → raw rate, then formatted per the category's rate format.
  // A scope whose display rate cannot be derived records its refusal and
  // yields a null rate — it never throws, so one refusing scope cannot hide
  // the rest of the dashboard or its editors.
  function buildCategory(
    id: string, key: string, name: string, color: string | null,
    categoryType: BurdenCategory["categoryType"], match: BurdenCategory["match"],
    expenseByDept: Record<string, number>, total: number, accounts: BurdenAccount[],
    expenseExactByDept: Record<string, string>,
    unratedHours?: string,
  ): BurdenCategory {
    const s = settingsOf(id);
    const allocationBase = s.allocationBase ?? "billed_hours";
    const allocationMethod = s.allocationMethod ?? "simple";
    const rateFormat = s.rateFormat ?? "per_hour";
    const includeInComposite = s.includeInComposite ?? true;
    const baseExact = baseExactFor(allocationBase);
    const byDept: Record<string, { amount: number; rate: number | null }> = {};
    const rateInput = {
        id, allocationMethod, allocationTiers: s.allocationTiers,
      allocationWeights: s.allocationWeights,
      expenseByDept: expenseExactByDept, baseByDept: baseExact,
      };
    const rawDeptRates = deriveOverheadCategoryDeptRates(rateInput);
    const exactRates: Record<string, string | null> = {};
    const sumExact = (values: Record<string, string>) =>
      Object.values(values).reduce(
        (total, value) => add(total, value),
        "0.0000",
      );
    const laborBase = baseExactFor("labor_dollars");
    const costBase = baseExactFor("direct_cost");
    const unitBase = baseExactFor("units");
    const displayRate = (
      rawRate: string,
      expense: string,
      deptId?: string,
    )
      : string | null => {
      if (rateFormat === "per_fte") {
        // A department resolves its own annual FTE hours only — borrowing
        // the org mean would price the department in hours it never worked.
        const annual = deptId ? (annualHoursByDept.get(deptId) ?? null) : overallAnnualHours;
        if (annual === null)
          return recordRefusal(id, deptId ?? null, deptId
            ? { code: "perFteNoHoursDept", message: strings.refusalPerFteNoHoursDept(name, deptNameOf(deptId)) }
            : { code: "perFteNoHours", message: strings.refusalPerFteNoHours(name) });
      }
      const value = deriveOverheadDisplayRate({
        rawRate,
        expense,
        rateFormat,
        laborDollars: deptId ? (laborBase[deptId] ?? "0") : sumExact(laborBase),
        directCost: deptId ? (costBase[deptId] ?? "0") : sumExact(costBase),
        units: deptId ? (unitBase[deptId] ?? "0") : sumExact(unitBase),
        annualFteHours: (deptId ? (annualHoursByDept.get(deptId) ?? null) : overallAnnualHours) ?? undefined,
      });
      if (value === null)
        return recordRefusal(id, deptId ?? null, {
          code: "missingBase",
          message: strings.refusalMissingBase(name, strings.rateFormatLabel(rateFormat), strings.allocationBaseLabel(allocationBase)),
        });
      return value;
    };
    for (const d of departmentsBase) {
      const exact = displayRate(
        rawDeptRates[d.id] ?? "0.0000",
        expenseExactByDept[d.id] ?? "0.0000",
        d.id,
      );
      exactRates[d.id] = exact;
      byDept[d.id] = { amount: expenseByDept[d.id] ?? 0, rate: exact === null ? null : toChartNumber(exact) };
    }
    const overallExpense = sumExact(expenseExactByDept);
    const rawRateExact = deriveOverheadOverallRate(rateInput);
    const overall = displayRate(rawRateExact, overallExpense);
    exactRatesByCat.set(id, { rates: exactRates,
      overall,
      expenses: expenseExactByDept });
    if (overall === null) {
      const refusal = overallRefusals.get(id);
      return {
        id, key, name, color, categoryType, match,
        totalAmount: total, rawRate: null, rate: null, rateDisplay: refusal?.message ?? "",
        allocationBase, allocationMethod, rateFormat, includeInComposite,
        accounts, byDept,
        ...(unratedHours !== undefined && cmp(unratedHours, "0") > 0 ? { unratedHours } : {}),
      };
    }
    const rawRate = Number(rawRateExact);
    const formatted = formatRate(
      rawRateExact, rateFormat,
      {
        laborDollars: sumExact(laborBase),
        directCost: sumExact(costBase),
        units: { total: sumExact(unitBase) },
        annualFteHours: overallAnnualHours ?? undefined,
      }, { totalExpense: overallExpense }, (value, options) => money(value, options));
    return {
      id, key, name, color, categoryType, match,
      totalAmount: total, rawRate, rate: formatted.value, rateDisplay: formatted.display,
      allocationBase, allocationMethod, rateFormat, includeInComposite,
      accounts, byDept,
      ...(unratedHours !== undefined && cmp(unratedHours, "0") > 0 ? { unratedHours } : {}),
    };
  }

  // Render a coded engine refusal with the loader's category name attached.
  const refuseFromValues = (
    code: OverheadRefusalCode | "perFteNoHoursDept" | "cascadingNoLaborDept",
    values: Record<string, string>,
  ): TrueCostRefusal => {
    const category = values["category"] ?? "";
    switch (code) {
      case "formulaReference":
        return { code, message: strings.refusalFormulaReference(category, values["reference"] ?? "") };
      case "formulaNegative":
        return { code, message: strings.refusalFormulaNegative(category, values["amount"] ?? "") };
      case "perFteNoHours":
        return { code, message: strings.refusalPerFteNoHours(category) };
      case "perFteNoHoursDept":
        return { code, message: strings.refusalPerFteNoHoursDept(category, values["dept"] ?? "") };
      case "cascadingNoLabor":
        return { code, message: strings.refusalCascadingNoLabor() };
      case "cascadingNoLaborDept":
        return { code, message: strings.refusalCascadingNoLaborDept(values["dept"] ?? "") };
      case "missingBase":
        return {
          code,
          message: strings.refusalMissingBase(category, values["format"] ?? "", values["base"] ?? ""),
        };
      default:
        return { code: "unreadableAmount", message: strings.refusalUnreadableAmount(category) };
    }
  };
  // A category whose build throws records its refusal and leaves the list:
  // corrupt configuration in one category never hides the others or the
  // editors. The loader names the category from the stored config.
  const refuseCategory = (error: unknown, catId: string, name: string): null => {
    if (error instanceof OverheadCalculationError && error.code) {
      recordRefusal(catId, null, refuseFromValues(error.code, { ...error.values, category: name }));
    } else if (error instanceof OverheadCalculationError) {
      recordRefusal(catId, null, { code: "unreadableAmount", message: strings.refusalUnreadableAmount(name) });
    } else throw error;
    return null;
  };
  const expenseCategories: BurdenCategory[] = [];
  for (const g of burdenGroups.groups) {
    const c = cats.get(g.id)!;
    const exactByDept = Object.fromEntries(splitUntaggedExact(c.byDeptTaggedExact, c.untaggedExact, settingsOf(g.id)?.allocationBase ?? "billed_hours"));
    // Display numerics cross from exact through Number at this boundary; the
    // exact maps flow separately for accumulation and the per-hour contract.
    const expenseByDept = Object.fromEntries(Object.entries(exactByDept).map(([k, v]): [string, number] => [k, Number(v)]));
    try {
      const built = buildCategory(c.id, c.key, c.name, c.color, "expense", g.match ?? {}, expenseByDept,
        toChartNumber(c.total), [...c.accounts.values()].sort((a, b) => cmp(b.amount, a.amount)), exactByDept);
      if (built.totalAmount !== 0) expenseCategories.push(built);
    } catch (error) {
      refuseCategory(error, c.id, c.name);
    }
  }

  // ---- native non-billable time category ---------------------------------------
  // A first-class burden category (not a hand-built custom one): the labour cost
  // of non-billable hours, spread over billed hours like every other rate.
  const timeCategories: BurdenCategory[] = [];
  if (cmp(timeTotalExact, "0") > 0 || cmp(unratedHoursExact, "0") > 0) {
    const timeExpenseByDept = Object.fromEntries([...timeExpenseExactByDept].map(([k, v]): [string, number] => [k, Number(v)]));
    try {
      timeCategories.push(buildCategory(TIME_ID, TIME_KEY, strings.timeCategoryName, "#8b5cf6", "time", {}, timeExpenseByDept, Number(timeTotalExact), [], Object.fromEntries(timeExpenseExactByDept), unratedHoursExact));
    } catch (error) {
      refuseCategory(error, TIME_ID, strings.timeCategoryName);
    }
  }

  // ---- custom categories (manual / derived / formula) --------------------------
  // categoryTotals carries exact decimal strings (never the display twins), so
  // derived and formula categories compute from the same exact totals the
  // ledger produced. The float bundle still feeds display only.
  const categoryTotals: Record<string, { expenseOverall: string }> = {};
  for (const g of burdenGroups.groups) {
    if (expenseCategories.some((e) => e.id === g.id)) categoryTotals[g.id] = { expenseOverall: cats.get(g.id)!.total };
  }
  if (timeCategories.length > 0) categoryTotals[TIME_ID] = { expenseOverall: timeTotalExact };
  // Exact per-department base maps for the shares custom categories divide by.
  const basesExact = {
    billed_hours: baseExactFor("billed_hours"),
    total_hours: baseExactFor("total_hours"),
    labor_dollars: baseExactFor("labor_dollars"),
    headcount: baseExactFor("headcount"),
    revenue: baseExactFor("revenue"),
    direct_cost: baseExactFor("direct_cost"),
    square_feet: baseExactFor("square_feet"),
    units: baseExactFor("units"),
    custom: baseExactFor("custom"),
  };
  const customCategories: BurdenCategory[] = [];
  for (const cc of profile.customCategories) {
    // A refusing custom category leaves the list and the totals: later
    // customs referencing it refuse in turn, each naming its own break, and
    // the stored record stays in the profile config for its editor.
    try {
      let calc: { expense: Record<string, number>; expenseExact?: Record<string, string>; totalExpense: number };
      if (cc.type === "manual") calc = calculateManualCategoryData(cc.manualConfig ?? {}, cc.allocationBase, deptIds, bases, basesExact);
      else if (cc.type === "derived") calc = calculateDerivedCategoryData(cc.derivedConfig ?? {}, categoryTotals, cc.allocationBase, deptIds, bases, basesExact);
      else calc = calculateFormulaCategoryData(cc.formulaConfig ?? {}, categoryTotals, cc.allocationBase, deptIds, bases, basesExact);
      let customOverall = "0.0000";
      for (const d of departmentsBase) customOverall = add(customOverall, calc.expenseExact?.[d.id] ?? "0.0000");
      categoryTotals[cc.id] = { expenseOverall: customOverall };
      // Custom category settings live on the category record itself.
      profile.categorySettings[cc.id] = { allocationBase: cc.allocationBase, rateFormat: cc.rateFormat, includeInComposite: cc.includeInComposite };
      // Synthetic expenses cross from float-land through exact shortest-repr
      // quantization (a no-op for ordinary config decimals like 100.50).
      const customExpenseExact: Record<string, string> = {};
      for (const d of departmentsBase) customExpenseExact[d.id] = calc.expenseExact?.[d.id] ?? quantizeOverheadMoney(calc.expense[d.id] ?? 0);
      const built = buildCategory(cc.id, cc.id, cc.name, cc.color, cc.type, {}, calc.expense, calc.totalExpense, [], customExpenseExact);
      if (Math.abs(built.totalAmount) > 0) customCategories.push(built);
    } catch (error) {
      refuseCategory(error, cc.id, cc.name);
    }
  }

  const categories: BurdenCategory[] = [...expenseCategories, ...timeCategories, ...customCategories];

  // ---- composite rate via the configured method () ---
  // The labor rate is measured (costed time) or explicitly configured on the
  // profile — never assumed. A scope with no rate records its refusal and
  // yields a null composite; the blend never throws past this section, so a
  // refusing scope cannot hide the rest of the payload or its editors.
  const typedEmployeeRows = empTranslated;
  const overallLaborRateExact: string | null =
    overallLaborRatedExact === "0.0000"
      ? (profile.baseLaborRate === "" || profile.baseLaborRate == null
        ? null
        : quantizeOverheadMoney(profile.baseLaborRate))
      : div(overallLaborCostExact, overallLaborRatedExact);
  const compositeInputOf = (rateOf: (id: string) => string | null, expenseOf: (id: string) => string) =>
    categories.map((category) => ({
      id: category.id,
      name: category.name,
      rate: rateOf(category.id) ?? "0.0000",
      expense: expenseOf(category.id),
      rateFormat: category.rateFormat,
      includeInComposite: category.includeInComposite,
    }));
  const overallExpenseOf = (id: string): string =>
    Object.values(exactRatesByCat.get(id)?.expenses ?? {}).reduce(
      (total, value) => add(total, value),
      "0.0000",
    );
  // An included category whose Overall rate refused voids the headline
  // blend: the composite would price without it.
  const blockedOverall = categories.find((c) => c.includeInComposite && (exactRatesByCat.get(c.id)?.overall ?? null) === null);
  // Translate a coded engine blend refusal with the loader's own names and
  // translated format labels — the engine message stays the contract-test
  // diagnostic, never user copy.
  const blendRefusal = (error: OverheadCalculationError, deptName?: string): TrueCostRefusal | null => {
    if (error.code === "mixedUnits") {
      const byFormat = new Map<string, string[]>();
      for (const c of categories) {
        if (!c.includeInComposite) continue;
        const list = byFormat.get(c.rateFormat) ?? [];
        list.push(`"${c.name}"`);
        byFormat.set(c.rateFormat, list);
      }
      const formats = [...byFormat.keys()].map((f) => strings.rateFormatLabel(f)).join(", ");
      const names = [...byFormat.values()].flat().join(", ");
      return { code: "mixedUnits", message: strings.refusalMixedUnits(formats, names) };
    }
    if (error.code === "cascadingNoLabor") {
      return deptName
        ? { code: "cascadingNoLaborDept", message: strings.refusalCascadingNoLaborDept(deptName) }
        : { code: "cascadingNoLabor", message: strings.refusalCascadingNoLabor() };
    }
    return null;
  };
  let compositeRate: number | null = null;
  let overallBlendRefusal: TrueCostRefusal | null = null;
  if (blockedOverall) {
    overallBlendRefusal = overallRefusals.get(blockedOverall.id)
      ?? { code: "unreadableAmount", message: strings.refusalUnreadableAmount(blockedOverall.name) };
  } else if (profile.compositeMethod === "cascading" && overallLaborRateExact === null) {
    overallBlendRefusal = { code: "cascadingNoLabor", message: strings.refusalCascadingNoLabor() };
  } else {
    try {
      const compositeRateExact = deriveOverheadDeptComposite({
        compositeMethod: profile.compositeMethod, baseLaborRate: overallLaborRateExact ?? undefined,
        categories: compositeInputOf((id) => exactRatesByCat.get(id)?.overall ?? null, overallExpenseOf),
      });
      compositeRate = Number(compositeRateExact);
    } catch (error) {
      if (error instanceof OverheadCalculationError && error.code) {
        const refusal = blendRefusal(error);
        if (refusal) overallBlendRefusal = refusal;
        else throw error;
      } else throw error;
    }
  }
  // A department without costed time has no department labor rate — it
  // refuses by name for cascading scopes instead of borrowing the Overall
  // figure, which would price the department in another's wage.
  const deptLaborRateExact = (deptId: string): string | null => {
    const leg = deptLaborExact.get(deptId);
    if (!leg || cmp(leg.rated, "0") <= 0) return null;
    return div(leg.cost, leg.rated);
  };

  const totalsByDept: Record<string, number | null> = {};
  const deptBlendRefusals = new Map<string, TrueCostRefusal>();
  // All preview composites use the exact contract. Non-hourly units still
  // refuse publication to an hourly rate card.
  const publishBlockers = overheadPublishBlockers(
    categories.map((c) => ({ id: c.id, name: c.name, rateFormat: c.rateFormat, includeInComposite: c.includeInComposite })),
  );
  const exactSupported = publishBlockers.length === 0;
  const departments: Dept[] = departmentsBase.map((d) => {
    let composite: number | null = null;
    let compositeExact = "";
    const blocked = categories.find((c) => c.includeInComposite && (exactRatesByCat.get(c.id)?.rates[d.id] ?? null) === null);
    if (blocked) {
      const refusal = deptRefusals.get(blocked.id)?.get(d.id)
        ?? { code: "unreadableAmount" as const, message: strings.refusalUnreadableAmount(blocked.name) };
      deptBlendRefusals.set(d.id, refusal);
    } else if (profile.compositeMethod === "cascading" && deptLaborRateExact(d.id) === null) {
      const refusal: TrueCostRefusal = { code: "cascadingNoLaborDept", message: strings.refusalCascadingNoLaborDept(d.name) };
      deptBlendRefusals.set(d.id, refusal);
    } else {
      try {
        const composite4 = deriveOverheadDeptComposite({
          compositeMethod: profile.compositeMethod,
          baseLaborRate: deptLaborRateExact(d.id) ?? undefined,
          categories: compositeInputOf(
            (id) => exactRatesByCat.get(id)?.rates[d.id] ?? null,
            (id) => exactRatesByCat.get(id)?.expenses[d.id] ?? "0.0000",
          ),
        });
        compositeExact = exactSupported
          ? formatOverheadPublishRate(composite4)
          : "";
        composite = Number(exactSupported ? compositeExact : composite4);
      } catch (error) {
        if (error instanceof OverheadCalculationError && error.code) {
          const refusal = blendRefusal(error, d.name);
          if (refusal) deptBlendRefusals.set(d.id, refusal);
          else throw error;
        } else throw error;
      }
    }
    totalsByDept[d.id] = composite;
    return { id: d.id, name: d.name, billedHours: d.hours.billed, totalHours: d.hours.total, unratedHours: toChartNumber(unratedHoursByDept.get(d.id) ?? "0.0000"), composite, compositeExact };
  });
  // The Overall headline refusal wins the single slot; otherwise the first
  // department-scope refusal in department order.
  const firstDeptRefusal = departmentsBase.map((d) => deptBlendRefusals.get(d.id)).find((r) => r !== undefined) ?? null;
  const compositeRefusal: TrueCostRefusal | null = overallBlendRefusal ?? firstDeptRefusal;

  // ---- absorption (actual applied burden only) ---------------------------------
  // With no applied postings there is nothing to compare against actuals:
  // the comparison is unavailable by name — never modelled from
  // utilization, never 100%.
  const glApplied = Number(appliedTotal);
  const hasBurdenGL = appliedLines > 0 && Math.abs(glApplied) > 0;
  const utilization = totalHours > 0 ? billedHours / totalHours : 0;
  const burdenApplied = hasBurdenGL ? glApplied : null;
  const gap = burdenApplied === null ? null : burdenApplied - totalOverhead;

  // ---- prior-window composite for the change chip (same classification) -----------
  const priorBilled = priorBilledHours;
  let priorBurdenExact = priorNonbillCost;
  const typedPriorRows = priorTranslated;
  for (const r of typedPriorRows) {
    if (directLabor.has(r.account_id)) continue;
    if (burdenGroups.byAccount.has(r.account_id))
      priorBurdenExact = add(priorBurdenExact, String(r.amount ?? 0));
  }
  const priorComposite = priorBilled > 0 ? toChartNumber(div(priorBurdenExact, quantizeOverheadMoney(priorBilled))) : 0;
  const compositeRateChangePct = priorComposite > 0 ? ((compositeRate - priorComposite) / priorComposite) * 100 : null;

  // ---- monthly history + linear forecast ---------------------------------------------
  const months = [...new Set([...monthBurden.keys(), ...monthHours.keys()])].sort();
  const monthly: MonthPoint[] = months.map((m) => {
    const burden = monthBurden.get(m) ?? "0.0000";
    const billed = monthHours.get(m)?.billed ?? 0;
    const catAmounts = monthCatRate.get(m);
    const byCategory: Record<string, number> = {};
    if (catAmounts) for (const [k, amt] of catAmounts) byCategory[k] = billed > 0 ? amt / billed : 0;
    const deptAmounts = monthDeptBurden.get(m);
    const byDept: Record<string, number> = {};
    if (deptAmounts) {
      for (const [deptId, amt] of deptAmounts) {
        const db_ = deptMonthBilled.get(`${deptId}|${m}`) ?? 0;
        byDept[deptId] = db_ > 0 ? amt / db_ : 0;
      }
    }
    return { month: m, label: strings.monthLabel(m), burden, billedHours: billed, rate: billed > 0 ? Number(burden) / billed : 0, byCategory, byDept };
  });

  // Linear regression over monthly composite → next 3 months. Outlier months
  // (one-off postings like year-end bonuses) are excluded from the FIT via a
  // median/MAD screen but still shown in the chart.
  const fitPoints = monthly
    .map((m, i) => ({ i, rate: m.rate }))
    .filter((p) => monthly[p.i]!.billedHours > 0);
  const forecast: TrueCostData["forecast"] = [];
  if (fitPoints.length >= 3 && months.length > 0) {
    const sortedRates = fitPoints.map((p) => p.rate).sort((a, b) => a - b);
    const median = sortedRates[Math.floor(sortedRates.length / 2)]!;
    const mad = fitPoints.map((p) => Math.abs(p.rate - median)).sort((a, b) => a - b)[Math.floor(fitPoints.length / 2)] || 1;
    const clean = fitPoints.filter((p) => Math.abs(p.rate - median) <= 3 * mad);
    const pts = clean.length >= 3 ? clean : fitPoints;
    const n = pts.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of pts) { sumX += p.i; sumY += p.rate; sumXY += p.i * p.rate; sumXX += p.i * p.i; }
    const denom = n * sumXX - sumX * sumX;
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;
    const last = months[months.length - 1]!;
    const lastIdx = monthly.length - 1;
    const [ly, lm] = last.split("-").map(Number);
    for (let i = 1; i <= 3; i++) {
      // utcDateFromParts keeps literal years 0001-0099 that Date.UTC would
      // remap onto 1900-1999.
      const d = utcDateFromParts(ly!, lm! - 1 + i, 1);
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      forecast.push({ month: ym, label: strings.monthLabel(ym), rate: Math.max(0, intercept + slope * (lastIdx + i)) });
    }
  }

  // ---- labour rates ------------------------------------------------------------------------
  const employees: EmployeeRate[] = typedEmployeeRows
    .map((r) => ({
      id: r.id, name: strings.displayEmployeeName(r.name), deptId: r.dept_id, deptName: r.dept_name, title: r.title,
      rate: toChartNumber(String(r.rate ?? 0)), hours: Number(r.hours ?? 0),
    }))
    .filter((e) => e.rate > 0);
  const laborHoursSum = employees.reduce((s, e) => s + e.hours, 0);
  const weighted = laborHoursSum > 0 ? employees.reduce((s, e) => s + e.rate * e.hours, 0) / laborHoursSum : 0;

  return {
    period,
    departments,
    compositeRefusal,
    kpis: {
      compositeRate,
      compositeRateChangePct,
      totalOverhead,
      overheadAccounts: categories.reduce((s, c) => s + c.accounts.length, 0),
      burdenApplied,
      gap,
      gapPerHour: gap === null || billedHours <= 0 ? null : gap / billedHours,
      absorptionPct: burdenApplied === null || totalOverhead <= 0 ? null : (burdenApplied / totalOverhead) * 100,
      billedHours,
      totalHours,
      utilization,
      employeeCount: employees.length,
    },
    categories,
    unassigned: [...unassignedMap.values()].filter((u) => cmp(u.amount, "0") !== 0).sort((a, b) => cmp(b.amount, a.amount)),
    totals: { byDept: totalsByDept, overall: compositeRate },
    labor: {
      employees: employees.sort((a, b) => b.hours - a.hours),
      count: employees.length,
      min: employees.length ? Math.min(...employees.map((e) => e.rate)) : 0,
      max: employees.length ? Math.max(...employees.map((e) => e.rate)) : 0,
      weighted,
      unratedHours: unratedHoursExact,
    },
    monthly,
    forecast,
    hasBurdenGL,
    absorptionUnavailable: hasBurdenGL
      ? null
      : (appliedAccountId ? strings.absorptionNoPostings : strings.absorptionNoAccount),
    bases,
    ratePublication: { supported: exactSupported, blockers: publishBlockers },
    config: {
      activeProfileId: cfg.activeProfileId,
      compositeMethod: profile.compositeMethod,
      baseLaborRate: profile.baseLaborRate,
      fringeRate: profile.fringeRate,
      categorySettings: profile.categorySettings,
      profiles: cfg.profiles.map((p) => ({ id: p.id, name: strings.displayProfileName(p.name), color: p.color })),
      customCategories: profile.customCategories,
    },
  };
}
