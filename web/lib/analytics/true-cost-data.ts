import "server-only";
import { statementBookExpr } from "../gl-summary";
import { isFeatureEnabled } from "../features";
import { getMoneyFormatter } from '../money-server'
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { add, div, mulDecimal, mulRatio, normalizeMoney, toUnits } from "@openbooks/engine/src/money/money.ts";
import {
  deriveOverheadCategoryDeptRates,
  deriveOverheadDeptComposite,
  formatOverheadPublishRate,
  overheadPublishBlockers,
  quantizeOverheadMoney,
  type OverheadPublishBlocker,
} from "@openbooks/engine/src/projects/overhead-rates.ts";
import { flowRates } from "../fx-presentation";
import { resolveAccountGroups } from "../account-groups";
import {
  type AllocationBase,
  type AllocationMethod,
  type RateFormat,
  type CompositeMethod,
  type AllocationBaseBundle,
  type CompositeCategory,
  calculateRate,
  formatRate,
  calculateCompositeRate,
  calculateManualCategoryData,
  calculateDerivedCategoryData,
  calculateFormulaCategoryData,
  getAllocationBaseValue,
} from "./true-cost-engine";
import { englishTrueCostStrings, type TrueCostStrings } from "./true-cost-strings";

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
 * Absorption: this ledger HAS an "Overhead Burden" GL account (5200) + a
 * clearing account, but neither carries postings — the applied-burden
 * mechanism is unused. Until it is, absorption uses the utilization-recovery
 * model: burden is only recovered on BILLABLE hours, so
 * applied = actual × utilization and The Gap = applied − actual. Stated in
 * the Configuration tab.
 */

export interface Dept {
  id: string;
  name: string;
  billedHours: number;
  totalHours: number;
  composite: number; // dept burden ÷ dept billed hours
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
  amount: number;
  /** Classification source: explicitly pinned vs matched by the group's rule. */
  pinned: boolean;
  /** Department-TAGGED amounts (untagged remainder allocates by hours share). */
  deptAmounts: Record<string, number>;
  untaggedAmount: number;
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
  rate: number; // the formatted rate value in the category's rate format
  /** Raw $/hr rate before formatting (totalAmount ÷ allocation base at Overall). */
  rawRate: number;
  /** Allocation settings applied to this category (rate engine). */
  allocationBase: AllocationBase;
  allocationMethod: AllocationMethod;
  rateFormat: RateFormat;
  includeInComposite: boolean;
  /** Locale- and currency-aware display string, or a percentage. */
  rateDisplay: string;
  accounts: BurdenAccount[];
  /** deptId → { amount, rate } (allocated where untagged). */
  byDept: Record<string, { amount: number; rate: number }>;
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
  burden: number;
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
  kpis: {
    compositeRate: number;
    compositeRateChangePct: number | null; // vs immediately-preceding equal window
    totalOverhead: number;
    overheadAccounts: number;
    burdenApplied: number;
    gap: number; // applied − actual (negative = under-absorbed)
    gapPerHour: number;
    absorptionPct: number;
    billedHours: number;
    totalHours: number;
    utilization: number;
    employeeCount: number;
  };
  categories: BurdenCategory[];
  unassigned: BurdenAccount[];
  totals: { byDept: Record<string, number>; overall: number };
  labor: { employees: EmployeeRate[]; count: number; min: number; max: number; weighted: number };
  monthly: MonthPoint[];
  forecast: { month: string; label: string; rate: number }[];
  hasBurdenGL: boolean; // the 5200 applied account carries postings
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
  /** Exact decimal twins of the merged hour sums (rate-derivation input). */
  billed_hours_exact?: string;
  total_hours_exact?: string;
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

/** Hours-weighted average labour cost rate (cascading composite base). */
function employeesWeightedRate(rows: EmployeeRateSqlRow[]): number {
  let wsum = 0, hsum = 0;
  for (const r of rows) {
    const rate = Number(r.rate ?? 0);
    const hours = Number(r.hours ?? 0);
    if (rate > 0 && hours > 0) { wsum += rate * hours; hsum += hours; }
  }
  return hsum > 0 ? wsum / hsum : 50;
}

export const DEFAULT_PROFILE: TrueCostProfile = {
  id: "default",
  name: "Default",
  color: "#3b82f6",
  compositeMethod: "sum",
  baseLaborRate: 50,
  fringeRate: 0.25,
  categorySettings: {},
  customCategories: [],
  baseOverrides: {},
};

/** Load the True Cost engine config and resolve the active profile (). */
export async function loadTrueCostConfig(orgId: string): Promise<{ activeProfileId: string; profiles: TrueCostProfile[]; profile: TrueCostProfile }> {
  const r = (await db.execute(sql`
    select settings -> 'analytics' -> 'trueCost' as cfg from orgs where id = ${orgId}
  `));
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
  strings: TrueCostStrings = englishTrueCostStrings,
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

  const [cfg, burdenGroups, poolGroups, acctRows, hoursRows, empRows, priorRows, priorTimeRows, appliedRows, deptRows, baseRows] = await Promise.all([
    loadTrueCostConfig(orgId),
    resolveAccountGroups("burden", orgId),
    resolveAccountGroups("cost_pool", orgId),
    // Expense account totals per account × department × month × functional —
    // journal legs arrive stamped in their line entity's functional and
    // translate to presentation before the burden math ever sees them.
    db.execute(sql`
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
    db.execute(sql`
      select t.department_id, to_char(t.worked_on, 'YYYY-MM') as month,
        coalesce(t.cost_rate_currency, crs.base_currency, o.base_currency) as func,
        max(t.worked_on)::text as late,
        sum(t.hours) as total_hours,
        coalesce(sum(t.hours) filter (where t.is_billable), 0) as billed_hours,
        coalesce(sum(t.hours * coalesce(t.cost_rate, 0)) filter (where t.is_billable is not true), 0) as nonbill_cost
      from time_entries t
      left join subsidiaries crs on crs.id = t.cost_rate_subsidiary_id and crs.org_id = t.org_id
      join orgs o on o.id = t.org_id
      where t.org_id = ${orgId} ${timeScope} and t.worked_on >= ${from} and t.worked_on <= ${to}
      group by 1, 2, 3
    `),
    // Per-employee weighted labour rate + dominant dept/labour class. Cost
    // legs arrive per (employee, functional) so the rate translates before
    // the division — a cross-currency average of raw rates is meaningless.
    db.execute(sql`
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
    `),
    // Prior equal window: per-account expense (classified below) + billed hours.
    db.execute(sql`
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
    `),
    // Prior-window non-billable labour cost per functional: the scalar
    // subselect above cannot carry legs, so it travels on its own query.
    db.execute(sql`
      select coalesce(t.cost_rate_currency, crs.base_currency, o.base_currency) as func,
        max(t.worked_on)::text as late,
        coalesce(sum(t.hours * coalesce(t.cost_rate, 0)) filter (where t.is_billable is not true), 0) as nonbill_cost
      from time_entries t
      left join subsidiaries crs on crs.id = t.cost_rate_subsidiary_id and crs.org_id = t.org_id
      join orgs o on o.id = t.org_id
      where t.org_id = ${orgId} ${timeScope} and t.worked_on >= ${priorFrom} and t.worked_on <= ${priorTo}
      group by 1
    `),
    // Does the "burden applied" GL mechanism carry postings in the period?
    db.execute(sql`
      select sub.base_currency as func, max(e.posting_date)::text as late,
        coalesce(-sum(l.amount), 0) as applied, count(*) as lines
      from journal_lines l
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      left join subsidiaries sub on sub.id = l.subsidiary_id and sub.org_id = l.org_id
      where l.org_id = ${orgId} ${ledgerScope} and a.name ~* 'burden applied|overhead burden'
        and e.posting_date >= ${from} and e.posting_date <= ${to}
      group by 1
    `),
    db.execute(sql`select id, name from departments where org_id = ${orgId} order by name`),
    // Allocation bases by department (): labour $,
    // headcount, revenue, direct cost. Hours come from the time legs above.
    // One grouped pass per source instead of a correlated GL subquery per
    // department per basis — that shape re-scanned the window's ledger three
    // times for every department on the page.
    // No entry join: the line carries its own posting date. And the account
    // classification is resolved once into id sets rather than joined per
    // line — the labour regex was being evaluated for every journal line in
    // the window.
    db.execute(sql`
      with gl as (
        select l.department_id, sub.base_currency as func, max(e.posting_date)::text as late,
               coalesce(sum(l.amount) filter (where l.account_id in (
                 select id from accounts where org_id = ${orgId}
                   and type in ('expense','expense_other','expense_deferred','cogs')
                   and name ~* 'wage|salary|payroll|labou?r')), 0) as labor_dollars,
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
      ),
      hc as (
        select t.department_id, count(distinct t.employee_party_id) as headcount
          from time_entries t
         where t.org_id = ${orgId} ${timeScope} and t.department_id is not null
           and t.worked_on >= ${from} and t.worked_on <= ${to}
         group by t.department_id
      )
      select d.id as dept_id, gl.func as func, max(gl.late) as late,
             coalesce(max(gl.labor_dollars), 0) as labor_dollars,
             coalesce(max(hc.headcount), 0) as headcount,
             coalesce(max(gl.revenue), 0) as revenue,
             coalesce(max(gl.direct_cost), 0) as direct_cost
        from departments d
        left join gl on gl.department_id = d.id
        left join hc on hc.department_id = d.id
       where d.org_id = ${orgId}
       group by d.id, gl.func
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
  const baseLegs = baseRows.rows as unknown as { dept_id: string; func: string | null; late: string | null; labor_dollars: TrueCostSqlNumeric; headcount: string | number; revenue: TrueCostSqlNumeric; direct_cost: TrueCostSqlNumeric }[];
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
  {
    const byKey = new Map<string, HoursSqlRow & { billed: number; total: number; nonbill: string; billedExact: string; totalExact: string }>();
    for (const r of hourLegs) {
      const key = JSON.stringify([r.department_id, r.month]);
      const prev = byKey.get(key) ?? { ...r, billed: 0, total: 0, nonbill: "0", billedExact: "0.0000", totalExact: "0.0000" };
      prev.billed += Number(r.billed_hours ?? 0);
      prev.total += Number(r.total_hours ?? 0);
      prev.billedExact = add(prev.billedExact, normalizeMoney(String(r.billed_hours ?? 0)));
      prev.totalExact = add(prev.totalExact, normalizeMoney(String(r.total_hours ?? 0)));
      prev.nonbill = add(String(prev.nonbill), translateLeg(String(r.nonbill_cost ?? 0), r.func ?? null, String(r.late ?? to).slice(0, 10), tcRateAt));
      byKey.set(key, prev);
    }
    for (const v of byKey.values()) {
      hourTranslated.push({ ...v, billed_hours: v.billed, total_hours: v.total, nonbill_cost: v.nonbill, billed_hours_exact: v.billedExact, total_hours_exact: v.totalExact });
    }
  }
  // Employee legs merged to one presentation row each: the rate is
  // translated cost over rated hours, never an average of raw rates.
  const empTranslated: EmployeeRateSqlRow[] = [];
  // Exact per-department labor cost ÷ rated hours for the cascading composite
  // base (mirrors the Overall hours-weighted average per department).
  const deptLaborExact = new Map<string, { cost: string; rated: string }>();
  let overallLaborCostExact = "0.0000";
  let overallLaborRatedExact = "0.0000";
  {
    const byId = new Map<string, { base: EmployeeRateSqlRow; hours: number; cost: string; rated: number; ratedExact: string }>();
    for (const r of empLegs) {
      const prev = byId.get(r.id) ?? { base: r, hours: 0, cost: "0", rated: 0, ratedExact: "0.0000" };
      prev.hours += Number(r.hours ?? 0);
      prev.rated += Number(r.rated_hours ?? 0);
      prev.ratedExact = add(prev.ratedExact, normalizeMoney(String(r.rated_hours ?? 0)));
      prev.cost = add(String(prev.cost), translateLeg(String(r.cost ?? 0), r.func ?? null, String(r.late ?? to).slice(0, 10), tcRateAt));
      byId.set(r.id, prev);
    }
    for (const v of byId.values()) {
      overallLaborCostExact = add(overallLaborCostExact, v.cost);
      overallLaborRatedExact = add(overallLaborRatedExact, v.ratedExact);
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
        rate: v.rated > 0 ? Number(v.cost) / v.rated : 0,
      });
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
  // Allocation bases merged per department; headcount re-added.
  type BaseCell = { labor_dollars: string; headcount: number; revenue: string; direct_cost: string };
  const baseTranslated = new Map<string, BaseCell>();
  for (const r of baseLegs) {
    const prev = baseTranslated.get(r.dept_id) ?? { labor_dollars: "0", headcount: 0, revenue: "0", direct_cost: "0" };
    const date = String(r.late ?? to).slice(0, 10);
    prev.labor_dollars = add(prev.labor_dollars, translateLeg(String(r.labor_dollars ?? 0), r.func ?? null, date, tcRateAt));
    prev.revenue = add(prev.revenue, translateLeg(String(r.revenue ?? 0), r.func ?? null, date, tcRateAt));
    prev.direct_cost = add(prev.direct_cost, translateLeg(String(r.direct_cost ?? 0), r.func ?? null, date, tcRateAt));
    prev.headcount += Number(r.headcount ?? 0);
    baseTranslated.set(r.dept_id, prev);
  }

  // ---- hours by department --------------------------------------------------
  const deptHours = new Map<string, { billed: number; total: number }>();
  const monthHours = new Map<string, { billed: number; total: number }>();
  const deptMonthBilled = new Map<string, number>(); // `${dept}|${month}`
  // Non-billable labour cost (the time category) by department and by month.
  const nonbillCostByDept = new Map<string, number>();
  const nonbillCostByMonth = new Map<string, number>();
  const nonbillCostByDeptMonth = new Map<string, number>(); // `${dept}|${month}`
  let billedHours = 0, totalHours = 0, nonbillCostTotal = 0;
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
    const nonbill = Number(r.nonbill_cost ?? 0);
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
    nonbillCostByDept.set(dept, (nonbillCostByDept.get(dept) ?? 0) + nonbill);
    nonbillCostByMonth.set(r.month, (nonbillCostByMonth.get(r.month) ?? 0) + nonbill);
    nonbillCostByDeptMonth.set(`${dept}|${r.month}`, (nonbillCostByDeptMonth.get(`${dept}|${r.month}`) ?? 0) + nonbill);
    billedHours += billed; totalHours += total; nonbillCostTotal += nonbill;
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
  const periodData = { laborDollars: bases.laborDollars, directCost: bases.directCost, units: bases.units, monthCount };

  // ---- classify expense into burden categories --------------------------------
  const directLabor = new Set(
    [...poolGroups.byAccount.entries()].filter(([, g]) => g.key === "direct_labor").map(([id]) => id),
  );

  interface CatAgg {
    id: string; key: string; name: string; color: string | null;
    total: number;
    accounts: Map<string, BurdenAccount>;
    byDept: Map<string, number>;
    /** Tagged-department exact amounts; untagged accumulates separately. */
    byDeptTaggedExact: Map<string, string>;
    untaggedExact: string;
    byMonth: Map<string, number>;
  }
  const cats = new Map<string, CatAgg>();
  for (const g of burdenGroups.groups) {
    cats.set(g.id, { id: g.id, key: g.key, name: g.name, color: g.color, total: 0, accounts: new Map(), byDept: new Map(), byDeptTaggedExact: new Map(), untaggedExact: "0.0000", byMonth: new Map() });
  }
  const unassignedMap = new Map<string, BurdenAccount>();
  const monthBurden = new Map<string, number>();
  const monthCatRate = new Map<string, Map<string, number>>(); // month → cat key → amount
  const monthDeptBurden = new Map<string, Map<string, number>>(); // month → dept → amount

  for (const r of acctTranslated) {
    if (directLabor.has(r.account_id)) continue; // direct labour is not burden
    const amount = Number(r.amount ?? 0);
    if (amount === 0) continue;
    // Exact twin: translated legs already sum in money strings, so this
    // validation is a no-op pass-through that fails closed on corruption.
    const amountExact = normalizeMoney(String(r.amount ?? 0));
    const group = burdenGroups.byAccount.get(r.account_id);

    if (!group) {
      const u = unassignedMap.get(r.account_id) ?? {
        id: r.account_id, number: r.number, name: r.name, amount: 0,
        pinned: false, deptAmounts: {} as Record<string, number>, untaggedAmount: 0,
      };
      u.amount += amount;
      if (r.department_id && billedShare.has(r.department_id)) {
        u.deptAmounts[r.department_id] = (u.deptAmounts[r.department_id] ?? 0) + amount;
      } else {
        u.untaggedAmount += amount;
      }
      unassignedMap.set(r.account_id, u);
      continue;
    }
    const cat = cats.get(group.groupId);
    if (!cat) continue;
    cat.total += amount;
    const acct = cat.accounts.get(r.account_id) ?? {
      id: r.account_id, number: r.number, name: r.name, amount: 0,
      pinned: burdenGroups.pinned.has(r.account_id), deptAmounts: {} as Record<string, number>, untaggedAmount: 0,
    };
    acct.amount += amount;
    if (r.department_id && billedShare.has(r.department_id)) {
      acct.deptAmounts[r.department_id] = (acct.deptAmounts[r.department_id] ?? 0) + amount;
    } else {
      acct.untaggedAmount += amount;
    }
    cat.accounts.set(r.account_id, acct);
    cat.byMonth.set(r.month, (cat.byMonth.get(r.month) ?? 0) + amount);
    monthBurden.set(r.month, (monthBurden.get(r.month) ?? 0) + amount);
    if (!monthCatRate.has(r.month)) monthCatRate.set(r.month, new Map());
    monthCatRate.get(r.month)!.set(cat.key, (monthCatRate.get(r.month)!.get(cat.key) ?? 0) + amount);

    // Department attribution: tagged stays; untagged allocated by billed-hours share.
    const spread = (deptId: string, amt: number) => {
      cat.byDept.set(deptId, (cat.byDept.get(deptId) ?? 0) + amt);
      if (!monthDeptBurden.has(r.month)) monthDeptBurden.set(r.month, new Map());
      const md = monthDeptBurden.get(r.month)!;
      md.set(deptId, (md.get(deptId) ?? 0) + amt);
    };
    if (r.department_id && billedShare.has(r.department_id)) {
      spread(r.department_id, amount);
      cat.byDeptTaggedExact.set(r.department_id, add(cat.byDeptTaggedExact.get(r.department_id) ?? "0.0000", amountExact));
    } else {
      for (const d of departmentsBase) spread(d.id, amount * (billedShare.get(d.id) ?? 0));
      // Exact untagged attribution happens once below (splitUntaggedExact):
      // per-row float shares stay display-only so rounding compounds once.
      cat.untaggedExact = add(cat.untaggedExact, amountExact);
    }
  }

  /**
   * Split one category's untagged exact total across burden centres by billed
   * hours — the exact twin of the per-row float spread above. Each
   * department's share is one exact proportional allocation (mulRatio,
   * halves away), so the published rate compounds rounding exactly once.
   */
  const splitUntaggedExact = (tagged: Map<string, string>, untagged: string): Map<string, string> => {
    const out = new Map<string, string>();
    const totalUnits = toUnits(billedHoursExact);
    for (const d of departmentsBase) {
      const share =
        totalUnits === 0n
          ? "0.0000"
          : mulRatio(untagged, toUnits(deptBilledExact.get(d.id) ?? "0.0000"), totalUnits);
      out.set(d.id, add(tagged.get(d.id) ?? "0.0000", share));
    }
    return out;
  };

  // ---- native non-billable time category ---------------------------------------
  // Distribute non-billable labour cost across burden centres (tagged dept kept,
  // untagged/no-billed-hours allocated by billed-hours share) and fold it into
  // the monthly burden series so trends, forecast and absorption all include it.
  const TIME_ID = "__nonbillable_time__";
  const TIME_KEY = "nonbillable_time";
  const timeExpenseByDept: Record<string, number> = {};
  for (const d of departmentsBase) timeExpenseByDept[d.id] = 0;
  for (const [dept, cost] of nonbillCostByDept) {
    if (cost === 0) continue;
    if (dept !== "none" && billedShare.has(dept)) timeExpenseByDept[dept]! += cost;
    else for (const d of departmentsBase) timeExpenseByDept[d.id]! += cost * (billedShare.get(d.id) ?? 0);
  }
  // Exact twin of the loop above, partitioned identically: non-billable legs
  // already merge in money strings, so the engine input never sees a float.
  const timeTaggedExact = new Map<string, string>();
  let timeUntaggedExact = "0.0000";
  for (const r of hourTranslated) {
    const costExact = normalizeMoney(String(r.nonbill_cost ?? 0));
    if (costExact === "0.0000") continue;
    const dept = r.department_id ?? "none";
    if (dept !== "none" && billedShare.has(dept)) {
      timeTaggedExact.set(dept, add(timeTaggedExact.get(dept) ?? "0.0000", costExact));
    } else {
      timeUntaggedExact = add(timeUntaggedExact, costExact);
    }
  }
  const timeExpenseExactByDept = splitUntaggedExact(timeTaggedExact, timeUntaggedExact);
  for (const [month, cost] of nonbillCostByMonth) {
    if (cost === 0) continue;
    monthBurden.set(month, (monthBurden.get(month) ?? 0) + cost);
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
    else for (const d of departmentsBase) md.set(d.id, (md.get(d.id) ?? 0) + cost * (billedShare.get(d.id) ?? 0));
  }

  const totalOverhead = [...cats.values()].reduce((s, c) => s + c.total, 0) + nonbillCostTotal;
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

  // Exact per-category department rates for the shared publish contract,
  // keyed by category id (per_hour categories only; other formats stay
  // display-only and block publication through the gate below).
  const exactRatesByCat = new Map<string, { rates: Record<string, string>; expenses: Record<string, string> }>();

  // Apply the rate engine to one category's expense-by-dept: allocation
  // base × method → raw rate, then formatted per the category's rate format.
  function buildCategory(
    id: string, key: string, name: string, color: string | null,
    categoryType: BurdenCategory["categoryType"], match: BurdenCategory["match"],
    expenseByDept: Record<string, number>, total: number, accounts: BurdenAccount[],
    expenseExactByDept: Record<string, string>,
  ): BurdenCategory {
    const s = settingsOf(id);
    const allocationBase = s.allocationBase ?? "billed_hours";
    const allocationMethod = s.allocationMethod ?? "simple";
    const rateFormat = s.rateFormat ?? "per_hour";
    const includeInComposite = s.includeInComposite ?? true;
    const baseExact = baseExactFor(allocationBase);
    const baseByDept: Record<string, number> = {};
    const byDept: Record<string, { amount: number; rate: number }> = {};
    // Department rates come from the shared exact contract for per-hour
    // categories (method-aware, no floats); other formats keep the legacy
    // display division and block publication instead of publishing
    // base-unit ratios as $/hr.
    const exactRates = rateFormat === "per_hour"
      ? deriveOverheadCategoryDeptRates({
        id, allocationMethod, allocationTiers: s.allocationTiers,
        expenseByDept: expenseExactByDept, baseByDept: baseExact,
      })
      : null;
    if (exactRates) exactRatesByCat.set(id, { rates: exactRates, expenses: expenseExactByDept });
    for (const d of departmentsBase) {
      const amount = expenseByDept[d.id] ?? 0;
      const deptBase = getAllocationBaseValue(allocationBase, bases, d.id);
      baseByDept[d.id] = deptBase;
      const exact = exactRates?.[d.id];
      byDept[d.id] = { amount, rate: exact !== undefined ? Number(exact) : (deptBase > 0 ? amount / deptBase : 0) };
    }
    const rawRate = allocationMethod === "weighted"
      ? calculateRate({ id, allocationMethod, allocationWeights: s.allocationWeights, allocationTiers: s.allocationTiers }, expenseByDept, baseByDept, allocationMethod)
      : calculateRate({ id, allocationMethod, allocationTiers: s.allocationTiers }, total, getAllocationBaseValue(allocationBase, bases, "Overall"), allocationMethod);
    const formatted = formatRate(rawRate, rateFormat, periodData, { totalExpense: total }, (value, options) => money(value, options));
    return {
      id, key, name, color, categoryType, match,
      totalAmount: total, rawRate, rate: formatted.value, rateDisplay: formatted.display,
      allocationBase, allocationMethod, rateFormat, includeInComposite,
      accounts, byDept,
    };
  }

  const expenseCategories: BurdenCategory[] = burdenGroups.groups.map((g) => {
    const c = cats.get(g.id)!;
    const expenseByDept: Record<string, number> = {};
    for (const d of departmentsBase) expenseByDept[d.id] = c.byDept.get(d.id) ?? 0;
    return buildCategory(c.id, c.key, c.name, c.color, "expense", g.match ?? {}, expenseByDept, c.total, [...c.accounts.values()].sort((a, b) => b.amount - a.amount), Object.fromEntries(splitUntaggedExact(c.byDeptTaggedExact, c.untaggedExact)));
  }).filter((c) => Math.abs(c.totalAmount) > 0);

  // ---- native non-billable time category ---------------------------------------
  // A first-class burden category (not a hand-built custom one): the labour cost
  // of non-billable hours, spread over billed hours like every other rate.
  const timeCategories: BurdenCategory[] = [];
  if (nonbillCostTotal > 0) {
    timeCategories.push(buildCategory(TIME_ID, TIME_KEY, strings.timeCategoryName, "#8b5cf6", "time", {}, timeExpenseByDept, nonbillCostTotal, [], Object.fromEntries(timeExpenseExactByDept)));
  }

  // ---- custom categories (manual / derived / formula) --------------------------
  // categoryTotals lets derived/formula reference other categories by id.
  const categoryTotals: Record<string, { expenseOverall: number }> = {};
  for (const c of expenseCategories) categoryTotals[c.id] = { expenseOverall: c.totalAmount };
  for (const c of timeCategories) categoryTotals[c.id] = { expenseOverall: c.totalAmount };
  const customCategories: BurdenCategory[] = [];
  for (const cc of profile.customCategories) {
    let calc: { expense: Record<string, number>; totalExpense: number };
    if (cc.type === "manual") calc = calculateManualCategoryData(cc.manualConfig ?? {}, cc.allocationBase, deptIds, bases);
    else if (cc.type === "derived") calc = calculateDerivedCategoryData(cc.derivedConfig ?? {}, categoryTotals, cc.allocationBase, deptIds, bases);
    else calc = calculateFormulaCategoryData(cc.formulaConfig ?? {}, categoryTotals, cc.allocationBase, deptIds, bases, strings);
    categoryTotals[cc.id] = { expenseOverall: calc.totalExpense };
    // Custom category settings live on the category record itself.
    profile.categorySettings[cc.id] = { allocationBase: cc.allocationBase, rateFormat: cc.rateFormat, includeInComposite: cc.includeInComposite };
    // Synthetic expenses cross from float-land through exact shortest-repr
    // quantization (a no-op for ordinary config decimals like 100.50).
    const customExpenseExact: Record<string, string> = {};
    for (const d of departmentsBase) customExpenseExact[d.id] = quantizeOverheadMoney(calc.expense[d.id] ?? 0);
    const built = buildCategory(cc.id, cc.id, cc.name, cc.color, cc.type, {}, calc.expense, calc.totalExpense, [], customExpenseExact);
    if (Math.abs(built.totalAmount) > 0) customCategories.push(built);
  }

  const categories: BurdenCategory[] = [...expenseCategories, ...timeCategories, ...customCategories];

  // ---- composite rate via the configured method () ---
  const typedEmployeeRows = empTranslated;
  const laborHoursSumForComposite = employeesWeightedRate(typedEmployeeRows);
  const compositeCats: CompositeCategory[] = categories.map((c) => ({
    id: c.id, rateValue: c.rate, totalExpense: c.totalAmount, rateFormat: c.rateFormat, includeInComposite: c.includeInComposite,
  }));
  const composite = calculateCompositeRate(compositeCats, { method: profile.compositeMethod, baseLaborRate: profile.baseLaborRate }, { avgLaborRate: laborHoursSumForComposite });
  const compositeRate = composite.value;

  // Exact Overall/department labor averages for the cascading composite base:
  // the hours-weighted cost rate each cascade runs over (Overall mirrors the
  // float `employeesWeightedRate` above; departments mirror it per centre).
  const overallLaborRateExact =
    overallLaborRatedExact === "0.0000" ? "50.0000" : div(overallLaborCostExact, overallLaborRatedExact);
  const deptLaborRateExact = (deptId: string): string => {
    const leg = deptLaborExact.get(deptId);
    if (!leg || leg.rated === "0.0000") return overallLaborRateExact;
    return div(leg.cost, leg.rated);
  };

  const totalsByDept: Record<string, number> = {};
  // Department composites run the SAME contract publication uses: the
  // configured composite method over exact per-department category rates, so
  // the Matrix preview can never disagree with the published card. A
  // non-hourly included format blocks the contract (blending it into a $/hr
  // card is a unit error): the preview falls back to the legacy display sum
  // and records why publication will refuse.
  const publishBlockers = overheadPublishBlockers(
    categories.map((c) => ({ id: c.id, name: c.name, rateFormat: c.rateFormat, includeInComposite: c.includeInComposite })),
  );
  const exactSupported = publishBlockers.length === 0;
  const departments: Dept[] = departmentsBase.map((d) => {
    let composite: number;
    let compositeExact = "";
    if (exactSupported) {
      const composite4 = deriveOverheadDeptComposite({
        compositeMethod: profile.compositeMethod,
        baseLaborRate: deptLaborRateExact(d.id),
        categories: categories
          .filter((c) => c.includeInComposite)
          .map((c) => ({
            id: c.id,
            rate: exactRatesByCat.get(c.id)?.rates[d.id] ?? "0.0000",
            expense: exactRatesByCat.get(c.id)?.expenses[d.id] ?? "0.0000",
            rateFormat: "per_hour" as const,
            includeInComposite: true,
          })),
      });
      compositeExact = formatOverheadPublishRate(composite4);
      composite = Number(compositeExact);
    } else {
      composite = categories.filter((c) => c.includeInComposite).reduce((s, c) => s + (c.byDept[d.id]?.rate ?? 0), 0);
    }
    totalsByDept[d.id] = composite;
    return { id: d.id, name: d.name, billedHours: d.hours.billed, totalHours: d.hours.total, composite, compositeExact };
  });

  // ---- absorption (utilization-recovery model unless the GL mechanism is live) --
  const glApplied = Number(appliedTotal);
  const hasBurdenGL = appliedLines > 0 && Math.abs(glApplied) > 0;
  const utilization = totalHours > 0 ? billedHours / totalHours : 0;
  const burdenApplied = hasBurdenGL ? glApplied : totalOverhead * utilization;
  const gap = burdenApplied - totalOverhead;

  // ---- prior-window composite for the change chip (same classification) -----------
  const priorBilled = priorBilledHours;
  let priorBurden = 0;
  const typedPriorRows = priorTranslated;
  for (const r of typedPriorRows) {
    if (directLabor.has(r.account_id)) continue;
    if (burdenGroups.byAccount.has(r.account_id)) priorBurden += Number(r.amount ?? 0);
  }
  priorBurden += Number(priorNonbillCost); // native time category
  const priorComposite = priorBilled > 0 ? priorBurden / priorBilled : 0;
  const compositeRateChangePct = priorComposite > 0 ? ((compositeRate - priorComposite) / priorComposite) * 100 : null;

  // ---- monthly history + linear forecast ---------------------------------------------
  const months = [...new Set([...monthBurden.keys(), ...monthHours.keys()])].sort();
  const monthly: MonthPoint[] = months.map((m) => {
    const burden = monthBurden.get(m) ?? 0;
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
    return { month: m, label: strings.monthLabel(m), burden, billedHours: billed, rate: billed > 0 ? burden / billed : 0, byCategory, byDept };
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
      const d = new Date(Date.UTC(ly!, lm! - 1 + i, 1));
      const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      forecast.push({ month: ym, label: strings.monthLabel(ym), rate: Math.max(0, intercept + slope * (lastIdx + i)) });
    }
  }

  // ---- labour rates ------------------------------------------------------------------------
  const employees: EmployeeRate[] = typedEmployeeRows
    .map((r) => ({
      id: r.id, name: strings.displayEmployeeName(r.name), deptId: r.dept_id, deptName: r.dept_name, title: r.title,
      rate: Number(r.rate ?? 0), hours: Number(r.hours ?? 0),
    }))
    .filter((e) => e.rate > 0);
  const laborHoursSum = employees.reduce((s, e) => s + e.hours, 0);
  const weighted = laborHoursSum > 0 ? employees.reduce((s, e) => s + e.rate * e.hours, 0) / laborHoursSum : 0;

  return {
    period,
    departments,
    kpis: {
      compositeRate,
      compositeRateChangePct,
      totalOverhead,
      overheadAccounts: categories.reduce((s, c) => s + c.accounts.length, 0),
      burdenApplied,
      gap,
      gapPerHour: billedHours > 0 ? gap / billedHours : 0,
      absorptionPct: totalOverhead > 0 ? (burdenApplied / totalOverhead) * 100 : 100,
      billedHours,
      totalHours,
      utilization,
      employeeCount: employees.length,
    },
    categories,
    unassigned: [...unassignedMap.values()].filter((u) => Math.abs(u.amount) > 0).sort((a, b) => b.amount - a.amount),
    totals: { byDept: totalsByDept, overall: compositeRate },
    labor: {
      employees: employees.sort((a, b) => b.hours - a.hours),
      count: employees.length,
      min: employees.length ? Math.min(...employees.map((e) => e.rate)) : 0,
      max: employees.length ? Math.max(...employees.map((e) => e.rate)) : 0,
      weighted,
    },
    monthly,
    forecast,
    hasBurdenGL,
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
