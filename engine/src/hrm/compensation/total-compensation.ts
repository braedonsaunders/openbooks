import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { businessToday } from "../../platform/business-date.ts";
import { orgFeatureEnabled } from "../../organization/org-feature-lock.ts";
import { add, cmp, div, mul, mulPercent, neg, roundMoney, sum } from "../../money/money.ts";
import {
  PAY_RATE_BASES,
  annualPayRate,
  hourlyPayRate,
  isPayRateBasis,
  isTimePayRateBasis,
  payRateIn,
  type PayRateBasis,
} from "../../projects/pay-rate-basis.ts";
import { laborCostingSettings, resolveWage } from "../../projects/labor-costing.ts";
import { recurringBenefitSource } from "../../payroll/benefit-plan-inputs.ts";
import { recurringBenefitAmount, type RecurringBenefitBasis } from "../../payroll/benefit-plan-math.ts";
import { meetsServiceYears } from "../../payroll/service-credit.ts";
import { PayrollError } from "../../payroll/error.ts";
import { loadCompensationLens, requireHrmCompensationReadOnEmployment } from "../authorization.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { requireActorId, requireOrgId } from "../recruiting/input.ts";
import { CompensationError } from "./errors.ts";

/**
 * Total compensation for one employment: what the employer pays this person,
 * restated per hour, week, month and year.
 *
 * Four sources, each labelled with how it is known:
 * - Base pay is the effective wage rate, quoted in its own basis and
 *   converted through the shared pay-rate conversion.
 * - Recurring benefits and allowances are PROJECTED for a year from the
 *   effective benefit elections and recurring pay components, with the same
 *   contribution math payroll applies. A term that payroll would refuse is
 *   listed with that refusal and left out of the total — never priced at zero.
 * - Statutory employer costs (pension plan, insurance, levies) and variable
 *   pay (bonuses and other non-periodic earnings) are ACTUAL amounts from
 *   committed payroll over the trailing twelve months.
 * Employee-paid contributions are shown beside the plans they fund but are
 * never added to the employer total. Amounts in another currency than the
 * base pay are listed and excluded from the total; no exchange rate is
 * assumed.
 */

export type CompensationCategory = "retirement" | "health" | "allowance" | "statutory" | "other";

export interface CompensationEmploymentOption {
  readonly id: string;
  readonly employer: string;
  readonly status: string | null;
}

export interface CompensationBasePay {
  readonly rateId: string;
  readonly rate: string;
  readonly basis: PayRateBasis;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly scope: "employee" | "job_title" | "trade" | "department" | "subsidiary" | "org";
  /** The rate restated in every basis, rounded to cents. */
  readonly equivalents: Readonly<Record<PayRateBasis, string>>;
}

export interface CompensationRateHistoryEntry {
  readonly id: string;
  readonly rate: string;
  readonly basis: PayRateBasis;
  readonly currency: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly annual: string;
  readonly hourly: string;
  /** Change in annual pay against the previous rate in the same currency, percent to 2 places. */
  readonly changePercent: string | null;
  readonly notes: string | null;
  readonly cycle: { readonly name: string; readonly kind: string; readonly reason: string | null } | null;
  readonly current: boolean;
}

export interface CompensationRecurringItem {
  readonly key: string;
  readonly source: "benefit" | "pay_component";
  readonly category: CompensationCategory;
  readonly name: string;
  readonly program: string | null;
  readonly paidBy: "employer" | "employee";
  readonly currency: string;
  /** Projected annual amount; null when it cannot be priced (see `refusal`). */
  readonly annual: string | null;
  /** The projected amount restated in every basis; null with `annual`. */
  readonly equivalents: Readonly<Record<PayRateBasis, string>> | null;
  readonly refusal: string | null;
}

export interface CompensationActualLine {
  readonly key: string;
  readonly name: string;
  readonly currency: string;
  readonly amount: string;
}

export interface CompensationVariablePayment {
  readonly payDate: string;
  readonly name: string;
  readonly runType: string;
  readonly currency: string;
  readonly amount: string;
}

export interface CompensationAward {
  readonly id: string;
  readonly program: string;
  readonly periodFrom: string;
  readonly currency: string;
  readonly value: string;
  readonly status: string;
}

export interface CompensationTotals {
  readonly currency: string;
  readonly base: string;
  readonly variable: string;
  readonly benefits: string;
  readonly statutory: string;
  readonly total: string;
  /** The annual total restated in every basis, rounded to cents. */
  readonly equivalents: Readonly<Record<PayRateBasis, string>>;
  readonly byCategory: ReadonlyArray<{
    readonly category: CompensationCategory | "base" | "variable";
    readonly annual: string;
    readonly equivalents: Readonly<Record<PayRateBasis, string>>;
    /** Share of the total, percent to 1 place. */
    readonly share: string;
  }>;
}

export interface TotalCompensation {
  readonly asOf: string;
  readonly employmentId: string;
  readonly employments: readonly CompensationEmploymentOption[];
  readonly annualHours: string;
  readonly annualHoursSource: "rate" | "settings";
  readonly payroll: {
    readonly enabled: boolean;
    readonly payBasis: string | null;
    readonly schedule: { readonly name: string; readonly frequency: string; readonly periodsPerYear: number } | null;
  };
  readonly base: CompensationBasePay | null;
  readonly history: readonly CompensationRateHistoryEntry[];
  readonly recurring: readonly CompensationRecurringItem[];
  /** Trailing-twelve-month window the actual amounts cover (inclusive). */
  readonly actualsWindow: { readonly from: string; readonly to: string } | null;
  readonly statutory: readonly CompensationActualLine[];
  readonly variable: readonly CompensationVariablePayment[];
  readonly variableHistory: readonly CompensationVariablePayment[];
  readonly awards: readonly CompensationAward[];
  /** Null without a base rate: there is nothing to restate per hour. */
  readonly totals: CompensationTotals | null;
}

const RETIREMENT_KINDS = new Set(["retirement", "pension", "rrsp", "savings"]);
const HEALTH_KINDS = new Set(["health", "medical", "dental", "vision", "life", "disability", "insurance"]);

function planCategory(kind: string): CompensationCategory {
  const normalized = kind.trim().toLowerCase();
  if (RETIREMENT_KINDS.has(normalized)) return "retirement";
  if (HEALTH_KINDS.has(normalized)) return "health";
  return "other";
}

function cents(value: string): string {
  return roundMoney(value, 2);
}

function restate(rate: string, basis: PayRateBasis, annualHours: string): Record<PayRateBasis, string> {
  const out = {} as Record<PayRateBasis, string>;
  for (const target of PAY_RATE_BASES) out[target] = cents(payRateIn(rate, basis, target, annualHours));
  return out;
}

function refusalText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "This term cannot be priced from its current configuration.";
}

async function loadEmployments(orgId: string, actorId: string, employeePartyId: string, asOf: string) {
  const lens = await loadCompensationLens(db, orgId, actorId);
  const rows = (await db.execute<{ id: string; employer: string; subsidiary_id: string; status: string | null; service_start: string | null }>(sql`
    select e.id::text as id, s.name as employer, e.employer_subsidiary_id::text as subsidiary_id,
           v.status, e.service_start::text as service_start
      from worker_employments e
      join subsidiaries s on s.org_id = e.org_id and s.id = e.employer_subsidiary_id
      left join lateral (
        select v.status from worker_employment_versions v
         where v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
           and v.effective_from <= ${asOf}::date
         order by v.effective_from desc limit 1
      ) v on true
     where e.org_id = ${orgId} and e.worker_party_id = ${employeePartyId}
     order by (v.status in ('active', 'on_leave')) desc nulls last, e.service_start desc nulls last, e.id`)).rows;
  return rows.filter((row) => lens === null || lens.has(row.subsidiary_id));
}

/** The effective rate row for the employee as of `asOf`, through the native wage resolution. */
async function loadBasePay(orgId: string, employeePartyId: string, asOf: string, settingsAnnualHours: number) {
  const resolved = await resolveWage(orgId, employeePartyId, asOf, { annualHoursDefault: settingsAnnualHours });
  if (!resolved) return null;
  const row = (await db.execute<{ id: string; rate: string; basis: string; annual_hours: string | null; currency: string; effective_from: string }>(sql`
    select id::text as id, rate::text as rate, basis, annual_hours::text as annual_hours, currency,
           effective_from::text as effective_from
      from labor_cost_rates where org_id = ${orgId} and id = ${resolved.rateId}`)).rows[0];
  if (!row || !isPayRateBasis(row.basis)) return null;
  return { row: { ...row, basis: row.basis }, scope: resolved.scope };
}

/**
 * The hours a year of this rate represents: a time-based rate's own annual
 * hours (it is the divisor its hourly equivalent was agreed against), else
 * the organization's labor-costing standard year.
 */
function annualHoursFor(basis: PayRateBasis, rowHours: string | null, settingsHours: number): { hours: string; source: "rate" | "settings" } {
  if (isTimePayRateBasis(basis) && rowHours !== null && cmp(rowHours, "0") > 0) return { hours: rowHours, source: "rate" };
  return { hours: String(settingsHours), source: "settings" };
}

async function loadHistory(orgId: string, employeePartyId: string, asOf: string, settingsHours: number): Promise<CompensationRateHistoryEntry[]> {
  const rows = (await db.execute<{
    id: string; rate: string; basis: string; annual_hours: string | null; currency: string;
    effective_from: string; effective_to: string | null; notes: string | null;
    cycle_name: string | null; cycle_kind: string | null; cycle_reason: string | null;
  }>(sql`
    select r.id::text as id, r.rate::text as rate, r.basis, r.annual_hours::text as annual_hours, r.currency,
           r.effective_from::text as effective_from, r.effective_to::text as effective_to, r.notes,
           c.name as cycle_name, c.kind as cycle_kind, l.reason as cycle_reason
      from labor_cost_rates r
      left join hrm_comp_cycle_lines l on l.org_id = r.org_id and l.pushed_rate_id = r.id
      left join hrm_comp_cycles c on c.org_id = l.org_id and c.id = l.cycle_id
     where r.org_id = ${orgId} and r.employee_party_id = ${employeePartyId} and r.is_active
     order by r.effective_from asc, r.id`)).rows;
  const out: CompensationRateHistoryEntry[] = [];
  const previousAnnual = new Map<string, string>();
  for (const row of rows) {
    if (!isPayRateBasis(row.basis)) continue;
    const hours = annualHoursFor(row.basis, row.annual_hours, settingsHours).hours;
    const annual = annualPayRate(row.rate, row.basis, hours);
    const prior = previousAnnual.get(row.currency);
    const changePercent = prior !== undefined && cmp(prior, "0") > 0
      ? roundMoney(div(mul(add(annual, neg(prior)), "100"), prior), 2)
      : null;
    previousAnnual.set(row.currency, annual);
    out.push({
      id: row.id,
      rate: row.rate,
      basis: row.basis,
      currency: row.currency,
      effectiveFrom: row.effective_from.slice(0, 10),
      effectiveTo: row.effective_to ? row.effective_to.slice(0, 10) : null,
      annual: cents(annual),
      hourly: cents(hourlyPayRate(row.rate, row.basis, hours)),
      changePercent,
      notes: row.notes,
      cycle: row.cycle_name ? { name: row.cycle_name, kind: row.cycle_kind ?? "adjustment", reason: row.cycle_reason } : null,
      current: row.effective_from.slice(0, 10) <= asOf && (row.effective_to === null || row.effective_to.slice(0, 10) >= asOf),
    });
  }
  return out.reverse();
}

interface PricingContext {
  readonly annualBase: string | null;
  readonly hourlyBase: string | null;
  readonly annualHours: string;
  readonly periodsPerYear: number | null;
}

async function projectBenefits(
  orgId: string,
  employmentId: string,
  subsidiaryId: string,
  asOf: string,
  context: PricingContext,
): Promise<CompensationRecurringItem[]> {
  const source = await recurringBenefitSource(db, {
    orgId, employmentId, subsidiaryId, periodStart: asOf, periodEnd: asOf, lock: false,
  });
  if (source.enrollments.length === 0) return [];
  const plans = new Map((await db.execute<{ id: string; name: string; kind: string }>(sql`
    select id::text as id, name, kind from hrm_benefit_plans
     where org_id = ${orgId} and id = any(${sql.param(source.enrollments.map((e) => e.planId))}::uuid[])`)).rows
    .map((plan) => [plan.id, plan]));
  const items: CompensationRecurringItem[] = [];
  for (const enrollment of source.enrollments) {
    if (enrollment.effectiveTo !== null && enrollment.effectiveTo < asOf) continue;
    const plan = plans.get(enrollment.planId);
    const minorUnits = source.currencyPrecisions.find((c) => c.code === enrollment.currency)?.minor_units;
    const tier = source.service
      ? enrollment.tiers.filter((t) => meetsServiceYears(source.service!, t.minimumServiceYears)).at(-1) ?? null
      : null;
    for (const term of enrollment.terms) {
      const rule = enrollment.rules.find((r) => r.id === term.ruleId);
      if (!rule) continue;
      const paidBy = rule.kind === "employee_deduction" ? "employee" : "employer";
      const category: CompensationCategory = rule.kind === "cash_earning" ? "allowance" : planCategory(plan?.kind ?? "");
      const base = {
        key: `benefit:${term.id}`,
        source: "benefit" as const,
        category,
        name: rule.name,
        program: plan?.name ?? enrollment.planCode,
        paidBy: paidBy as "employer" | "employee",
        currency: enrollment.currency,
      };
      try {
        if (minorUnits === undefined) throw new Error(`${enrollment.currency} has no registered precision — configure the currency before pricing this plan.`);
        const declaredPeriods = term.declaredPeriodsPerYear ?? rule.periodsPerYear;
        const periods = ["per_month", "per_year"].includes(rule.basis)
          ? context.periodsPerYear ?? declaredPeriods
          : context.periodsPerYear ?? (rule.basis === "per_period" ? null : 1);
        if (periods === null) {
          throw new Error("This contribution is priced per pay period — assign the employee a payroll pay schedule to project it for a year.");
        }
        if (rule.basis === "percent_of_eligible_pay" && context.annualBase === null) {
          throw new Error("This contribution is a percent of pay — record a wage rate for the employee to project it.");
        }
        const matchingTerm = enrollment.terms.find((t) => t.ruleId === rule.matchRuleId);
        const basis: RecurringBenefitBasis = {
          hours: div(context.annualHours, String(periods)),
          eligiblePay: context.annualBase === null ? "0" : div(context.annualBase, String(periods)),
          hourlyWage: context.hourlyBase,
          periodsPerYear: periods,
          currencyMinorUnits: minorUnits,
          coveredDays: 1,
          periodDays: 1,
          matchEligible: enrollment.matchEligible,
          tier,
          matchingElectedRate: matchingTerm?.electionMode === "fixed" ? matchingTerm.electedRate : null,
        };
        const perPeriod = recurringBenefitAmount(rule, term, basis).amount;
        const annual = mul(perPeriod, String(periods));
        items.push({ ...base, annual: cents(annual), equivalents: restate(annual, "year", context.annualHours), refusal: null });
      } catch (error) {
        items.push({ ...base, annual: null, equivalents: null, refusal: refusalText(error) });
      }
    }
  }
  return items;
}

async function projectPayComponents(
  orgId: string,
  employeePartyId: string,
  employmentId: string,
  asOf: string,
  currency: string | null,
  context: PricingContext,
): Promise<CompensationRecurringItem[]> {
  const rows = (await db.execute<{
    id: string; name: string; kind: string; basis: string; value: string | null; tax_treatment: string | null; payment_kind: string;
  }>(sql`
    select a.id::text as id, c.name, c.kind, c.basis, coalesce(a.value, c.value)::text as value,
           c.tax_treatment, c.payment_kind
      from employee_pay_components a
      join pay_components c on c.org_id = a.org_id and c.id = a.component_id
     where a.org_id = ${orgId} and a.employee_party_id = ${employeePartyId} and a.is_active
       and (a.employment_id is null or a.employment_id = ${employmentId})
       and a.effective_from <= ${asOf}::date and (a.effective_to is null or a.effective_to >= ${asOf}::date)
       and c.is_active and c.system_key is null
     order by c.sequence, c.name, a.id`)).rows;
  return rows.map((row) => {
    const paidBy: "employer" | "employee" = row.kind === "deduction" ? "employee" : "employer";
    const category: CompensationCategory = row.kind === "earning" ? "allowance"
      : row.tax_treatment === "pension_f" ? "retirement" : "other";
    const base = {
      key: `component:${row.id}`, source: "pay_component" as const, category, name: row.name, program: null, paidBy,
      currency: currency ?? "",
    };
    try {
      if (row.value === null) throw new Error("This recurring component has no amount — record its amount on the employee or the component.");
      let annual: string;
      if (row.basis === "per_hour") annual = mul(row.value, context.annualHours);
      else if (row.basis === "percent_of_gross") {
        if (context.annualBase === null) throw new Error("This component is a percent of gross pay — record a wage rate for the employee to project it.");
        annual = mulPercent(context.annualBase, row.value);
      } else {
        if (context.periodsPerYear === null) throw new Error("This component is an amount per pay period — assign the employee a payroll pay schedule to project it for a year.");
        annual = mul(row.value, String(context.periodsPerYear));
      }
      return { ...base, annual: cents(annual), equivalents: restate(annual, "year", context.annualHours), refusal: null };
    } catch (error) {
      return { ...base, annual: null, equivalents: null, refusal: refusalText(error) };
    }
  });
}

/** One employment's total compensation, as of the organization's business date. */
export async function employeeTotalCompensation(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly employeePartyId: string;
  readonly employmentId?: string | null;
}): Promise<TotalCompensation> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (!(await orgFeatureEnabled(orgId, HRM_FEATURE_KEY, db))) {
    throw new CompensationError("REFUSED", "Total compensation needs HRM — enable it in Company Settings → Features.");
  }
  const asOf = await businessToday(orgId);
  const employments = await loadEmployments(orgId, actorId, query.employeePartyId, asOf);
  const selected = query.employmentId ? employments.find((e) => e.id === query.employmentId) : employments[0];
  if (!selected) {
    throw new CompensationError("NOT_FOUND", "This person has no employment visible to you — record an employment in HRM to see their compensation.");
  }
  const subject = await requireHrmCompensationReadOnEmployment(db, orgId, actorId, selected.id);
  if (subject.workerPartyId !== query.employeePartyId) {
    throw new CompensationError("NOT_FOUND", "This employment is not visible in this organization and legal-entity scope.");
  }

  const settings = await laborCostingSettings(orgId);
  const payrollEnabled = await orgFeatureEnabled(orgId, "payroll", db);
  const profile = payrollEnabled
    ? (await db.execute<{ pay_basis: string; name: string; frequency: string; periods_per_year: number }>(sql`
        select p.pay_basis, s.name, s.frequency, s.periods_per_year
          from employee_payroll_profiles p
          join pay_schedules s on s.org_id = p.org_id and s.id = p.pay_schedule_id
         where p.org_id = ${orgId} and p.employee_party_id = ${query.employeePartyId}`)).rows[0] ?? null
    : null;

  const resolved = await loadBasePay(orgId, query.employeePartyId, asOf, settings.annualHours);
  const hours = resolved
    ? annualHoursFor(resolved.row.basis, resolved.row.annual_hours, settings.annualHours)
    : { hours: String(settings.annualHours), source: "settings" as const };
  const base: CompensationBasePay | null = resolved
    ? {
        rateId: resolved.row.id,
        rate: resolved.row.rate,
        basis: resolved.row.basis,
        currency: resolved.row.currency,
        effectiveFrom: resolved.row.effective_from.slice(0, 10),
        scope: resolved.scope,
        equivalents: restate(resolved.row.rate, resolved.row.basis, hours.hours),
      }
    : null;
  const context: PricingContext = {
    annualBase: resolved ? annualPayRate(resolved.row.rate, resolved.row.basis, hours.hours) : null,
    hourlyBase: resolved ? hourlyPayRate(resolved.row.rate, resolved.row.basis, hours.hours) : null,
    annualHours: hours.hours,
    periodsPerYear: profile ? Number(profile.periods_per_year) : null,
  };

  const [history, benefits, components] = await Promise.all([
    loadHistory(orgId, query.employeePartyId, asOf, settings.annualHours),
    projectBenefits(orgId, selected.id, subject.employerSubsidiaryId, asOf, context).catch((error: unknown) => {
      // The benefit configuration itself is inconsistent (for example,
      // overlapping service baselines): the refusal and its remedy reach the
      // reader instead of a partial statement.
      if (error instanceof PayrollError) throw new CompensationError("REFUSED", error.message);
      throw error;
    }),
    payrollEnabled
      ? projectPayComponents(orgId, query.employeePartyId, selected.id, asOf, base?.currency ?? null, context)
      : Promise.resolve([] as CompensationRecurringItem[]),
  ]);
  const recurring = [...benefits, ...components];

  const committedStubs = sql`
    from pay_stubs s
    join pay_runs r on r.org_id = s.org_id and r.document_id = s.pay_run_document_id
    join documents d on d.org_id = r.org_id and d.id = r.document_id
    join pay_stub_lines l on l.org_id = s.org_id and l.stub_id = s.id
    left join pay_components c on c.org_id = l.org_id and c.id = l.component_id
   where s.org_id = ${orgId} and s.employment_id = ${selected.id}
     and r.run_status = 'committed' and d.status <> 'voided'`;
  const variablePredicate = sql`l.kind = 'earning' and (coalesce(c.non_periodic, false) or r.run_type = 'bonus' or c.system_key = 'bonus')`;
  const windowFrom = (await db.execute<{ from: string }>(sql`select ((${asOf}::date - interval '1 year') + interval '1 day')::date::text as "from"`)).rows[0]!.from;
  type VariableRow = { pay_date: string; name: string; run_type: string; currency: string; amount: string };
  const variableColumns = sql`select s.pay_date::text as pay_date, coalesce(c.name, l.description) as name,
    r.run_type, s.currency_code as currency, l.amount::text as amount`;
  const [statutoryRows, variableRows, variableHistoryRows, awardRows] = await Promise.all([
    payrollEnabled ? db.execute<{ key: string; name: string; currency: string; amount: string }>(sql`
      select coalesce(c.id::text, l.description) as key, coalesce(c.name, l.description) as name,
             s.currency_code as currency, sum(l.amount)::text as amount
      ${committedStubs}
        and l.kind = 'employer_contribution' and c.system_key is not null
        and s.pay_date between ${windowFrom}::date and ${asOf}::date
      group by 1, 2, 3 having sum(l.amount) <> 0 order by 2`) : Promise.resolve({ rows: [] }),
    // The annual amount and payment count include every line in the window;
    // the display limit on history must never truncate financial totals.
    payrollEnabled ? db.execute<VariableRow>(sql`
      ${variableColumns}
      ${committedStubs} and ${variablePredicate}
        and s.pay_date between ${windowFrom}::date and ${asOf}::date
      order by s.pay_date desc, l.id`) : Promise.resolve({ rows: [] }),
    payrollEnabled ? db.execute<VariableRow>(sql`
      ${variableColumns}
      ${committedStubs} and ${variablePredicate}
      order by s.pay_date desc, l.id limit 200`) : Promise.resolve({ rows: [] }),
    db.execute<{ id: string; program: string | null; period_from: string; currency: string; value: string; status: string }>(sql`
      select a.id::text as id, a.program_snapshot->>'name' as program, a.period_from::text as period_from,
             a.currency, a.value::text as value, a.status
        from hrm_benefit_awards a
       where a.org_id = ${orgId} and a.employment_id = ${selected.id} and a.status <> 'voided'
       order by a.period_from desc, a.created_at desc limit 100`),
  ]);

  const variablePayment = (row: VariableRow): CompensationVariablePayment => ({
    payDate: row.pay_date.slice(0, 10), name: row.name, runType: row.run_type, currency: row.currency, amount: row.amount,
  });
  const variableHistory = variableHistoryRows.rows.map(variablePayment);
  const variable = variableRows.rows.map(variablePayment);
  const statutory: CompensationActualLine[] = statutoryRows.rows.map((row) => ({
    key: row.key, name: row.name, currency: row.currency, amount: row.amount,
  }));

  let totals: CompensationTotals | null = null;
  if (base && context.annualBase !== null) {
    const currency = base.currency;
    const inCurrency = <T extends { currency: string }>(rows: readonly T[]) => rows.filter((row) => row.currency === currency);
    const employerRecurring = inCurrency(recurring).filter((item) => item.paidBy === "employer" && item.annual !== null);
    const benefitsTotal = sum(employerRecurring.map((item) => item.annual!));
    const statutoryTotal = sum(inCurrency(statutory).map((row) => row.amount));
    const variableTotal = sum(inCurrency(variable).map((row) => row.amount));
    const baseAnnual = cents(context.annualBase);
    const total = sum([baseAnnual, variableTotal, benefitsTotal, statutoryTotal]);
    const byCategory = new Map<CompensationCategory | "base" | "variable", string>([["base", baseAnnual]]);
    if (cmp(variableTotal, "0") !== 0) byCategory.set("variable", variableTotal);
    for (const item of employerRecurring) byCategory.set(item.category, add(byCategory.get(item.category) ?? "0", item.annual!));
    if (cmp(statutoryTotal, "0") !== 0) byCategory.set("statutory", add(byCategory.get("statutory") ?? "0", statutoryTotal));
    totals = {
      currency,
      base: baseAnnual,
      variable: cents(variableTotal),
      benefits: cents(benefitsTotal),
      statutory: cents(statutoryTotal),
      total: cents(total),
      equivalents: restate(total, "year", hours.hours),
      byCategory: [...byCategory.entries()].map(([category, annual]) => ({
        category,
        annual: cents(annual),
        equivalents: restate(annual, "year", hours.hours),
        share: cmp(total, "0") > 0 ? roundMoney(div(mul(annual, "100"), total), 1) : "0",
      })),
    };
  }

  return {
    asOf,
    employmentId: selected.id,
    employments: employments.map((row) => ({ id: row.id, employer: row.employer, status: row.status })),
    annualHours: hours.hours,
    annualHoursSource: hours.source,
    payroll: {
      enabled: payrollEnabled,
      payBasis: profile?.pay_basis ?? null,
      schedule: profile ? { name: profile.name, frequency: profile.frequency, periodsPerYear: Number(profile.periods_per_year) } : null,
    },
    base,
    history,
    recurring,
    actualsWindow: payrollEnabled ? { from: windowFrom, to: asOf } : null,
    statutory,
    variable,
    variableHistory,
    awards: awardRows.rows.map((row) => ({
      id: row.id, program: row.program ?? "", periodFrom: row.period_from.slice(0, 10), currency: row.currency, value: row.value, status: row.status,
    })),
    totals,
  };
}
