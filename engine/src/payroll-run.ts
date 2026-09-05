import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "./db.ts";
import { PayrollError } from "./payroll-error.ts";
import {
  add, cmp, fromUnits, mulDecimal, mulPercent, mulRatio, neg, roundDiv, roundMoney, sum, toUnits,
} from "./money.ts";
import {
  payrollCertificate,
  resolveCertificate,
  type ResolvedCertificate,
  type StoredCertificate,
} from "./payroll/certificates.ts";
import {
  assertContributoryBasesDeclared,
  jurisdictionKey,
  labourJurisdictionProblem,
  legacyStatutoryLiabilityAccount,
  packStatutoryComponents,
  PayrollJurisdictionError,
  payrollJurisdictionDeclared,
  payrollPack,
  assertPayrollRegionSupported,
  resolveEmployeePayrollContext,
  resolvePayrollRunContext,
  type EmployeePayrollContext,
  type PayrollAssessedOn,
  type PayrollRunContext,
} from "./payroll/packs.ts";
import { createPushStatutory } from "./payroll/push-statutory.ts";
import { EMPTY_EMPLOYER_LEVY_FACTORS } from "./payroll/statutory-context.ts";
import {
  resolveStatutoryHolidayPay,
  undeclaredJurisdictionHolidayConflict,
  type StatutoryHolidayEligibilityFacts,
  type StatutoryHolidayEarningLine,
} from "./payroll-holidays.ts";
import { effectivePayRateSql, payRateIsUsable } from "./payroll-rate.ts";
// Aliased: the local closure keeps the same name, and this module is the one
// home for "how much of this component has the employee already taken".
import { componentYearToDate as openingComponentYtd } from "./payroll-opening-balances.ts";
import { effectiveFilingAccountSql } from "./payroll-filing.ts";
import { convertLaborWage, laborCostingSettings } from "./labor-costing.ts";
import { businessToday } from "./business-date.ts";
import {
  loadActiveDerivedRules,
  resolveDerivedEarnings,
} from "./payroll-derived-earnings.ts";
import {
  entitlementBalances,
  entitlementPlans,
  planMovementsForStub,
  recordEntitlementMovements,
  vacationPlanOf,
  type EntitlementPlan,
  type EntitlementWarning,
} from "./payroll-entitlements.ts";
import {
  payrollPaymentMethodSettings,
  resolvePayrollPaymentMethod,
} from "./payroll-payment-method.ts";
import {
  applyBasisCaps,
  applyDeductionProtection,
  assertEarningsAssessedStable,
  dropIncomeAssessedLines,
  protectedBase,
  protectionConverged,
  protectionNeedsIteration,
  PROTECTION_MAX_PASSES,
  settleProtectionOscillation,
  totalShortfall,
  type DeductionShortfall,
  type EarningsAssessedLine,
  type ProtectionBase,
} from "./payroll-limits.ts";

/**
 * Pay run pipeline: create → calculate → commit → (standard document post).
 *
 * A pay run is documents kind 'pay_run'. Stubs and their lines are the
 * payroll subledger; commit materializes the balanced GL projection into
 * document_lines (signed, like a journal), so posting, voiding, numbering,
 * and period control ride the standard machinery in engine/src/posting.ts.
 *
 * Wages resolve from labor_cost_rates (employee scope — the one-table
 * doctrine); statutory amounts come from the versioned T4127 engine. YTD
 * state = payroll_opening_balances + previously committed stubs, so
 * recalculating an uncommitted run is always safe.
 */

export interface PayrollSettings {
  /** DR for wages when a component has no expense account of its own. */
  wageExpenseAccountId: string | null;
  /** DR for employer statutory burden (CPP/EI employer share, vacation). */
  burdenExpenseAccountId: string | null;
  /** CR net pay owed to employees (relieved by the payment). */
  netPayAccountId: string | null;
  /** CR statutory withholdings pending remittance to the CRA. */
  cppPayableAccountId: string | null;
  eiPayableAccountId: string | null;
  taxPayableAccountId: string | null;
  vacationPayableAccountId: string | null;
  /**
   * Where time-driven wages debit. 'labor_clearing' washes the standard cost
   * already posted at time approval (labor costing mode 'post') so the
   * existing clearing true-up converges; 'expense' debits wage expense with
   * project splits straight from the time entries.
   */
  wagesTo: "expense" | "labor_clearing";
  /** Vendor party used when raising CRA remittance bills. */
  craRemittancePartyId: string | null;
  /**
   * Vendor party for Revenu Québec remittances (TPZ-1015.R): a QC stub's
   * QPP/QPP2/QPIP route here per the CA pack's regional remittance
   * declaration (engine/src/payroll/packs.ts), never to the CRA vendor.
   */
  rqRemittancePartyId: string | null;
}

export async function payrollSettings(
  orgId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<PayrollSettings> {
  if (allowedSubsidiaryIds != null) {
    const root = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and parent_id is null and is_active
       order by created_at limit 1
    `)).rows[0]?.id ?? null;
    if (!payrollSubsidiaryInScope(allowedSubsidiaryIds, root)) {
      throw new PayrollError("payroll settings not found");
    }
  }
  const r = (await db.execute<{ p: Record<string, unknown> | null; c: Record<string, unknown> | null }>(
    sql`select settings->'payroll' as p, settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  ));
  const p = (r.rows[0]?.p ?? {}) as Record<string, string | null>;
  return {
    wageExpenseAccountId: p.wageExpenseAccountId ?? null,
    burdenExpenseAccountId: p.burdenExpenseAccountId ?? null,
    netPayAccountId: p.netPayAccountId ?? null,
    cppPayableAccountId: p.cppPayableAccountId ?? null,
    eiPayableAccountId: p.eiPayableAccountId ?? null,
    taxPayableAccountId: p.taxPayableAccountId ?? null,
    vacationPayableAccountId: p.vacationPayableAccountId ?? null,
    wagesTo: p.wagesTo === "labor_clearing" ? "labor_clearing" : "expense",
    craRemittancePartyId: p.craRemittancePartyId ?? null,
    rqRemittancePartyId: p.rqRemittancePartyId ?? null,
  };
}

// Defined in its own cycle-free module so `extends PayrollError` is safe at
// module-evaluation time anywhere in payroll; re-exported here because this is
// where the rest of the codebase has always imported it from.
export { PayrollError };

/**
 * Exact `amount ÷ divisor`, rounded ONCE to `decimalPlaces`.
 *
 * Payroll divides money constantly — a salary by its periods, an annual rate
 * by its annual hours — and a reciprocal taken in binary floating point does
 * not survive the trip: `(1 / 1800).toFixed(10)` produces a factor whose
 * product with 125,000 is 69.4445 where the exact quotient is 69.4444, and
 * because that number IS the stored four-decimal hourly wage the error is
 * multiplied by every hour on every stub, always in the same direction. This
 * stays in BigInt from end to end (money.ts `roundDiv`) and rounds exactly
 * once, so no intermediate rounding can carry a half-cent across a boundary
 * either.
 */
export function divideMoney(amount: string, divisor: string, decimalPlaces = 4): string {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 4) {
    throw new PayrollError("decimalPlaces must be an integer from 0 through 4");
  }
  const divisorUnits = toUnits(divisor);
  if (divisorUnits <= 0n) throw new PayrollError(`cannot divide pay by ${divisor}`);
  const quantum = 10n ** BigInt(4 - decimalPlaces);
  return fromUnits(roundDiv(toUnits(amount) * 10_000n, divisorUnits * quantum) * quantum);
}

/**
 * Split `amount` across weighted buckets so that the parts sum EXACTLY to it —
 * the last bucket absorbs the rounding remainder.
 *
 * Returns an empty array when the weights cannot carry an allocation (no
 * buckets, nothing to weight by, or a negative weight), which the callers read
 * as "emit one unsplit line". Allocating each part independently instead makes
 * a job-costed employer line disagree with the identically-computed employee
 * line by a cent purely because of how the hours happened to fall across jobs.
 */
function allocateProportionally<T>(
  amount: string,
  buckets: readonly { weight: string; target: T }[],
): { amount: string; target: T }[] {
  if (buckets.length === 0) return [];
  let totalUnits = 0n;
  for (const bucket of buckets) {
    const units = toUnits(bucket.weight);
    if (units < 0n) return [];
    totalUnits += units;
  }
  if (totalUnits <= 0n) return [];
  const allocations: { amount: string; target: T }[] = [];
  let allocated = "0";
  for (const [index, bucket] of buckets.entries()) {
    const share = index === buckets.length - 1
      ? add(amount, neg(allocated))
      : roundMoney(mulRatio(amount, toUnits(bucket.weight), totalUnits), 2);
    allocated = add(allocated, share);
    allocations.push({ amount: share, target: bucket.target });
  }
  return allocations;
}

interface SeedComponent {
  code: string; name: string; kind: string; systemKey: string | null;
  basis?: string; taxable?: boolean; pensionable?: boolean; insurable?: boolean;
  vacationable?: boolean; nonPeriodic?: boolean; sequence: number;
  /** Country pack the row belongs to; omitted = shared across packs. */
  country?: string;
}

/**
 * Statutory holiday pay and its worked-the-day premium: ordinary EARNINGS with
 * ordinary treatment — taxable, pensionable, insurable and vacationable in
 * every jurisdiction that has them, because statutory holiday pay is wages.
 * The premium line carries only the UPLIFT over the regular wage (the hours
 * themselves are already paid at 1.0× by the timesheet).
 *
 * Declared separately so `ensureStatutoryHolidayComponents` can provision
 * exactly this pair for orgs that predate it.
 */
const STAT_HOLIDAY_COMPONENTS: SeedComponent[] = [
  { code: "STAT", name: "Statutory holiday pay", kind: "earning", systemKey: "stat_holiday", sequence: 25 },
  { code: "STATPREM", name: "Statutory holiday premium", kind: "earning", systemKey: "stat_holiday_premium", sequence: 26 },
];

/** Jurisdiction-free earning baseline shared by every country pack. */
const BASELINE_COMPONENTS: SeedComponent[] = [
  { code: "BASE", name: "Base pay", kind: "earning", systemKey: "base_pay", basis: "per_hour", sequence: 10 },
  { code: "OT", name: "Overtime", kind: "earning", systemKey: "overtime", basis: "per_hour", sequence: 20 },
  ...STAT_HOLIDAY_COMPONENTS,
  { code: "BONUS", name: "Bonus", kind: "earning", systemKey: "bonus", nonPeriodic: true, vacationable: false, sequence: 30 },
  { code: "VACPAY", name: "Vacation pay", kind: "earning", systemKey: "vacation_payout", vacationable: false, sequence: 40 },
];

/**
 * The statutory rows ARE the country pack's declaration
 * (engine/src/payroll/packs.ts): one place declares a jurisdiction's statutory
 * component set, its system keys, and what each one is assessed on, and this
 * provisions exactly that. Adding a levy to a pack therefore seeds it and
 * classifies it in the same edit — it cannot be seeded unclassified.
 *
 * The earning flags accumulate whatever contributory bases the pack DECLARES
 * (`contributoryBases` in packs.ts): CPP/EI for the CRA, FICA/FUTA wages for
 * the IRS. Seeding asserts the declaration exists, so a pack cannot inherit
 * another jurisdiction's meaning for `pensionable` by silence.
 */
const statutoryComponents = (country: string): SeedComponent[] =>
  packStatutoryComponents(country).map((component) => ({
    code: component.code, name: component.name, kind: component.kind,
    systemKey: component.systemKey, sequence: component.sequence, country,
  }));

/** One idempotent component insert — the single seeding path. */
async function ensureComponents(
  executor: Pick<typeof db, "execute">,
  orgId: string, actorId: string | null, rows: readonly SeedComponent[],
): Promise<void> {
  for (const c of rows) {
    await executor.execute(sql`
      insert into pay_components (org_id, code, name, kind, system_key, country, basis, taxable,
                                  pensionable, insurable, vacationable, non_periodic, sequence,
                                  created_by, updated_by)
      values (${orgId}, ${c.code}, ${c.name}, ${c.kind}, ${c.systemKey}, ${c.country ?? null},
              ${c.basis ?? "fixed_amount"},
              ${c.taxable ?? true}, ${c.pensionable ?? true}, ${c.insurable ?? true},
              ${c.vacationable ?? true}, ${c.nonPeriodic ?? false}, ${c.sequence}, ${actorId}, ${actorId})
      on conflict (org_id, code) do nothing
    `);
  }
}

/**
 * Statutory + baseline components for a country pack; idempotent.
 *
 * `country` has NO default. The old `= "CA"` default was Canada as the
 * module's identity: a caller that forgot the argument provisioned CPP and EI
 * for an org that may never employ a Canadian, and a third pack reached
 * through the settings route's cast would have seeded the CANADIAN set. The
 * pack registry is the only validator — an unknown country throws out of
 * `packStatutoryComponents` before anything is written.
 */
export async function seedPayrollComponents(
  orgId: string, actorId: string | null, country: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<void> {
  if (allowedSubsidiaryIds != null) {
    const root = (await db.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and parent_id is null and is_active
       order by created_at limit 1
    `)).rows[0]?.id ?? null;
    if (!payrollSubsidiaryInScope(allowedSubsidiaryIds, root)) {
      throw new PayrollError("payroll settings not found");
    }
  }
  // A pack whose contributory-bases declaration is missing (authored through
  // a cast) must fail before its flags accumulate an unnamed base.
  assertContributoryBasesDeclared(country);
  await ensureComponents(db, orgId, actorId, [...BASELINE_COMPONENTS, ...statutoryComponents(country)]);
  await seedVacationEntitlementPlan(orgId, actorId, country);
}

/**
 * The statutory-holiday earning pair, ensured idempotently for orgs
 * provisioned before the components existed. Called by the pay run whenever
 * the feature is ON, so `ctx.need("stat_holiday", …)` is never the discovery
 * mechanism for a missing component on a long-lived tenant.
 */
export async function ensureStatutoryHolidayComponents(
  executor: Pick<typeof db, "execute">, orgId: string, actorId: string | null,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<void> {
  if (allowedSubsidiaryIds != null) {
    const root = (await executor.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and parent_id is null and is_active
       order by created_at limit 1
    `)).rows[0]?.id ?? null;
    if (!payrollSubsidiaryInScope(allowedSubsidiaryIds, root)) {
      throw new PayrollError("payroll settings not found");
    }
  }
  await ensureComponents(executor, orgId, actorId, STAT_HOLIDAY_COMPONENTS);
}

/**
 * Whether statutory holiday pay is calculated at all
 * (orgs.settings.payroll.statutoryHolidayPay).
 *
 * Default OFF: the phase changes gross pay, so a tenant that has been running
 * payroll without it must opt in deliberately rather than find every stub
 * changed by an upgrade. The pack-install path turns it on for a NEW install
 * only (web/app/api/payroll/settings/route.ts).
 */
export async function statutoryHolidayPayEnabled(
  orgId: string,
  executorOrScope: Pick<typeof db, "execute"> | PayrollSubsidiaryScope = db,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<boolean> {
  const isExecutor = executorOrScope != null
    && typeof executorOrScope === "object" && "execute" in executorOrScope;
  const executor = isExecutor
    ? executorOrScope as Pick<typeof db, "execute">
    : db;
  const scope = allowedSubsidiaryIds !== undefined
    ? allowedSubsidiaryIds
    : (isExecutor ? undefined : executorOrScope as PayrollSubsidiaryScope);
  if (scope != null) {
    const root = (await executor.execute<{ id: string }>(sql`
      select id from subsidiaries
       where org_id = ${orgId} and parent_id is null and is_active
       order by created_at limit 1
    `)).rows[0]?.id ?? null;
    if (!payrollSubsidiaryInScope(scope, root)) {
      throw new PayrollError("payroll settings not found");
    }
  }
  const r = (await executor.execute<{ enabled: string | null }>(sql`
    select settings#>>'{payroll,statutoryHolidayPay}' as enabled from orgs where id = ${orgId}
  `));
  return r.rows[0]?.enabled === "true";
}

/**
 * The Vacation entitlement plan, provisioned beside the components it drives.
 *
 * Vacation accrual is an ENTITLEMENT PLAN, not a component: the plan engine
 * owns the accrual, the bank, the caps and the payout
 * (engine/src/payroll-entitlements.ts). The pack seeds the vacation_accrual /
 * vacation_payout components, so without this the components existed and the
 * plan did not, and a fresh org silently accrued nothing at all until somebody
 * ran scripts/migrate-vacation-to-entitlements.ts. Provisioning belongs beside
 * the components, not in a one-off script.
 *
 * Seeded only where the country pack actually declares a vacation accrual —
 * the US pack has no such levy, so a US-only org gets no plan and, if one of
 * its employees is nonetheless configured to accrue, the pay run says so out
 * loud (see `assertVacationPlanResolved`).
 *
 * Idempotent, and safe on a tenant that already migrated: an existing plan
 * carrying the binding is left completely alone, and a legacy "VAC" plan is
 * adopted by having the binding stamped onto it rather than being duplicated.
 */
async function seedVacationEntitlementPlan(
  orgId: string, actorId: string | null, country: string,
): Promise<void> {
  const declaresVacation = packStatutoryComponents(country)
    .some((component) => component.systemKey === "vacation_accrual");
  if (!declaresVacation) return;

  // The plan's BASE rate. Per-employee rates keep their one home on the
  // payroll profile (employee_payroll_profiles.vacation_percent) and service
  // tiers raise them; this is only what an employee with neither falls back
  // to. Same derivation the migration script uses, so a migrated tenant and a
  // freshly seeded one land on the same number.
  const modal = (await db.execute<{ percent: string }>(sql`
    select vacation_percent::text as percent
      from employee_payroll_profiles
     where org_id = ${orgId} and vacation_percent is not null and vacation_percent > 0
     group by vacation_percent
     order by count(*) desc, vacation_percent asc
     limit 1
  `));
  const accrualValue = roundMoney(modal.rows[0]?.percent ?? "4", 4);

  await db.execute(sql`
    insert into entitlement_plans (org_id, code, system_key, name, unit, direction, accrual_method,
                                   accrual_value, accrual_component_id, payout_component_id,
                                   liability_account_id, cap_behavior, is_active,
                                   created_by, updated_by)
    select ${orgId}, 'VAC', 'vacation', 'Vacation', 'money', 'accrue', 'percent_of_earnings',
           ${accrualValue},
           (select id from pay_components
             where org_id = ${orgId} and system_key = 'vacation_accrual' limit 1),
           (select id from pay_components
             where org_id = ${orgId} and system_key = 'vacation_payout' limit 1),
           (select (settings#>>'{payroll,vacationPayableAccountId}')::uuid
              from orgs where id = ${orgId}),
           'warn', true, ${actorId}, ${actorId}
     where not exists (
       select 1 from entitlement_plans where org_id = ${orgId} and system_key = 'vacation'
     )
    on conflict (org_id, code) do update
       set system_key = 'vacation',
           accrual_component_id = coalesce(entitlement_plans.accrual_component_id,
                                           excluded.accrual_component_id),
           payout_component_id = coalesce(entitlement_plans.payout_component_id,
                                          excluded.payout_component_id),
           liability_account_id = coalesce(entitlement_plans.liability_account_id,
                                           excluded.liability_account_id),
           updated_by = ${actorId}, updated_at = now()
     where entitlement_plans.org_id = ${orgId}
  `);
}

/**
 * An employee configured to BANK vacation must have a bank to put it in.
 *
 * The failure this exists to make impossible: a tenant whose Vacation plan is
 * missing (never migrated) or renamed accrued nothing at all, silently — 4% of
 * every employee's gross, every period, with the liability understated and no
 * error anywhere in the run, the readiness check, or the stub. A missing
 * accrual is money the employee is owed; it is never a no-op.
 *
 * Only the accrue case throws: `pay_each_period` and a final pay settle the
 * vacation in cash and need no plan at all.
 */
function assertVacationPlanResolved(
  emp: Record<string, string | null>,
  vacationPlan: EntitlementPlan | null,
  terminationRun: boolean,
): void {
  if (vacationPlan) return;
  const percent = emp.vacation_percent;
  if (!percent || cmp(percent, "0") <= 0) return;
  if (terminationRun || emp.vacation_method === "pay_each_period") return;
  throw new PayrollError(
    `${emp.display_name ?? emp.party_id} accrues ${percent}% vacation, but this organization `
    + "has no vacation entitlement plan to accrue it into — create one in Payroll setup → "
    + "Entitlement plans (or set the employee's vacation method to pay each period)",
  );
}
type ScheduleRow = {
  id: string; frequency: string; periods_per_year: number;
  anchor_period_end: string; pay_date_offset_days: number;
};

const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(`${s}T00:00:00Z`);

/**
 * The two days of the month a semi-monthly schedule's periods end on.
 *
 * `month_end` is a boundary KIND, not a day number: the second half of a month
 * runs to whatever the month's last day is (31, 30, 29, 28), which no
 * day-of-month can express.
 */
export interface SemiMonthlyBoundaries {
  /** Day-of-month the FIRST period of each month ends on (1–15). */
  firstDay: number;
  /** Day-of-month the SECOND period ends on, or the month's last day. */
  secondDay: number | "month_end";
}

const ORDINAL_SUFFIX = (day: number): string => {
  if (day % 100 >= 11 && day % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][day % 10] ?? "th";
};
const ordinal = (day: number): string => `${day}${ORDINAL_SUFFIX(day)}`;

const monthLengthOf = (d: Date): number =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();

/**
 * Why an anchor cannot name a semi-monthly schedule, or null if it can.
 *
 * The derivation rule (see `semiMonthlyBoundaries`) needs BOTH period-end days
 * to be unambiguous in every month of the year. Two anchor shapes are not, and
 * are refused by name at save time rather than quietly reinterpreted:
 *
 * - **the 14th** — its half-month complement is the 29th, which February does
 *   not always have, and "the 14th and the month end" is not a half-month
 *   split of anything. There is no second boundary to derive.
 * - **the last day of a 28-day February** — read as a day-of-month it means
 *   the 28th (a day every month has, complement the 13th); read as the month
 *   end it means the 15th-and-month-end schedule. Both readings are coherent
 *   and they are different calendars, so the anchor does not determine one.
 *   Anchoring on a 30- or 31-day month's last day says month end with no
 *   ambiguity at all.
 *
 * Everything else derives: 1–13 and 16–28 are fixed day pairs, and 15 / 29 /
 * 30 / 31 all mean "the 15th and the month end" (29, 30 and 31 are not days
 * every month has, so month end is their only coherent reading).
 */
export function semiMonthlyAnchorProblem(anchorPeriodEnd: string): string | null {
  const anchor = at(anchorPeriodEnd);
  if (Number.isNaN(anchor.getTime())) {
    return `"${anchorPeriodEnd}" is not a date, so no semi-monthly period can be derived from it`;
  }
  const day = anchor.getUTCDate();
  const monthLength = monthLengthOf(anchor);
  if (day === 28 && monthLength === 28) {
    return "a semi-monthly schedule anchored on the last day of February cannot be read: the 28th "
      + "is both a day every month has (periods would end on the 13th and the 28th) and February's "
      + "month end (periods would end on the 15th and the last day of the month), and those are "
      + "different calendars — anchor it on the last day of a 30- or 31-day month for the "
      + "15th-and-month-end schedule, or on the 28th of a longer month to mean the 28th";
  }
  if (day === 14) {
    return "a semi-monthly schedule anchored on the 14th has no second period end: half a month "
      + "later is the 29th, which February does not always have — anchor it on a day from 1 to 13 "
      + "or 16 to 28 (its complement is then the same day ±15), on the 15th, or on the last day of "
      + "a 30- or 31-day month (the 15th-and-month-end schedule)";
  }
  return null;
}

/**
 * Factor P must be a count the schedule's own boundaries can actually produce.
 *
 * `periods_per_year` is not decoration: the statutory engines annualize on it
 * (T4127 factor P, Pub 15-T's periods-per-year), so a semi-monthly calendar
 * saved with 26 pays 24 times a year while every withholding calculation
 * annualizes as though it paid 26 — wrong tax for everyone on the schedule,
 * every period, with nothing on screen to show it. The table's own CHECK only
 * constrains the value to the union of all frequencies' legal counts, which is
 * why the pairing has to be enforced here.
 *
 * 53 and 27 are the long-year counts (a year containing 53 Fridays, or 27
 * biweekly paydays) and are legal for exactly the frequencies that can have
 * them. Semi-monthly and monthly are defined by the calendar month, so they
 * admit no long year.
 */
const PERIODS_PER_YEAR_BY_FREQUENCY: Record<string, number[]> = {
  weekly: [52, 53],
  biweekly: [26, 27],
  semi_monthly: [24],
  monthly: [12],
};

export function payPeriodsPerYearProblem(
  frequency: string,
  periodsPerYear: number,
): string | null {
  const legal = PERIODS_PER_YEAR_BY_FREQUENCY[frequency];
  if (!legal) return null; // unknown frequency is the enum's refusal, not ours
  if (legal.includes(periodsPerYear)) return null;
  const allowed = legal.length === 1
    ? `${legal[0]}`
    : `${legal.slice(0, -1).join(", ")} or ${legal[legal.length - 1]}`;
  return `a ${frequency.replace(/_/g, "-")} schedule pays ${allowed} times a year, not `
    + `${periodsPerYear} — the periods per year is what every statutory calculation annualizes `
    + `with, so a count the schedule's own period boundaries cannot produce withholds the wrong `
    + `tax on every pay`;
}

/**
 * The period-end days a semi-monthly schedule uses, derived from its anchor —
 * the same way the monthly branch derives from its anchor's day-of-month.
 *
 * `anchor_period_end` is `notNull` on `pay_schedules`; discarding it for one
 * frequency is what let an employer paying the 5th and the 20th save without
 * error and then be paid on the 15th and the month end.
 */
export function semiMonthlyBoundaries(anchorPeriodEnd: string): SemiMonthlyBoundaries {
  const problem = semiMonthlyAnchorProblem(anchorPeriodEnd);
  if (problem) throw new PayrollError(problem);
  const day = at(anchorPeriodEnd).getUTCDate();
  // 29, 30 and 31 are not days every month has, so an anchor on one of them
  // can only mean the month end; the month end's half-month partner is the
  // 15th, because the halves of a month are the 1st–15th and the 16th–last.
  if (day === 15 || day >= 29) return { firstDay: 15, secondDay: "month_end" };
  return day < 15
    ? { firstDay: day, secondDay: day + 15 }
    : { firstDay: day - 15, secondDay: day };
}

/** The two period-end dates the boundaries produce in one calendar month. */
function semiMonthlyEndsIn(
  boundaries: SemiMonthlyBoundaries, year: number, month: number,
): [Date, Date] {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const second = boundaries.secondDay === "month_end" ? lastDay : boundaries.secondDay;
  return [new Date(Date.UTC(year, month, boundaries.firstDay)), new Date(Date.UTC(year, month, second))];
}

/** Period boundaries for a schedule: [start, end] containing/after `from`. */
export function nextPeriodAfter(
  schedule: Pick<ScheduleRow, "frequency" | "anchor_period_end">,
  lastPeriodEnd: string | null,
): { periodStart: string; periodEnd: string } {
  const anchor = at(schedule.anchor_period_end);
  if (schedule.frequency === "weekly" || schedule.frequency === "biweekly") {
    const span = schedule.frequency === "weekly" ? 7 : 14;
    let end = anchor;
    if (lastPeriodEnd) {
      const last = at(lastPeriodEnd);
      const steps = Math.max(1, Math.ceil((last.getTime() - anchor.getTime()) / (span * DAY) + 1));
      end = new Date(anchor.getTime() + steps * span * DAY);
      while (end.getTime() <= last.getTime()) end = new Date(end.getTime() + span * DAY);
    }
    return { periodStart: iso(new Date(end.getTime() - (span - 1) * DAY)), periodEnd: iso(end) };
  }
  if (schedule.frequency === "semi_monthly") {
    // The anchor's own day-of-month is one of the two boundaries, and its
    // half-month complement is the other — so an anchor of 2026-01-20 pays the
    // 6th–20th and the 21st–5th, not 1–15 / 16–EOM.
    const boundaries = semiMonthlyBoundaries(schedule.anchor_period_end);
    const cursor = lastPeriodEnd ? at(lastPeriodEnd) : new Date(anchor.getTime() - DAY);
    // Starting a month BEFORE the cursor's month guarantees the preceding
    // boundary is known before the first candidate is accepted, so the period
    // START is always the day after the previous period ended — including
    // across a month boundary, where it lives in the previous month.
    // Seeded from the month before the cursor's, both of whose boundaries are
    // necessarily on or before the cursor.
    const seed = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1));
    let previous = semiMonthlyEndsIn(boundaries, seed.getUTCFullYear(), seed.getUTCMonth())[1];
    for (let m = 0; m < 26; m++) {
      const base = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + m, 1));
      for (const end of semiMonthlyEndsIn(boundaries, base.getUTCFullYear(), base.getUTCMonth())) {
        if (end.getTime() > cursor.getTime()) {
          return { periodStart: iso(new Date(previous.getTime() + DAY)), periodEnd: iso(end) };
        }
        previous = end;
      }
    }
    throw new PayrollError("could not derive the next semi-monthly period");
  }
  // monthly: end on the anchor's day-of-month, clamped to month end.
  const anchorDay = anchor.getUTCDate();
  let cursor = lastPeriodEnd ? at(lastPeriodEnd) : new Date(anchor.getTime() - DAY);
  for (let m = 0; m < 14; m++) {
    const y = cursor.getUTCFullYear();
    const mo = cursor.getUTCMonth() + m;
    const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    const end = new Date(Date.UTC(y, mo, Math.min(anchorDay, lastDay)));
    if (end.getTime() > cursor.getTime()) {
      const prevLast = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      const start = new Date(Date.UTC(y, mo - 1, Math.min(anchorDay, prevLast) + 1));
      return { periodStart: iso(start), periodEnd: iso(end) };
    }
  }
  throw new PayrollError("could not derive the next monthly period");
}

/**
 * `retro` pays, in the current period, the difference a backdated change makes
 * to periods that have ALREADY been paid (engine/src/payroll-retro.ts). Like
 * `bonus` and `termination` it is off-cycle: landing inside an already-paid
 * period is the entire point, so it is exempt from the regular-run overlap
 * guard below, which only ever inspected `run_type = 'regular'`.
 */
export type PayRunType = "regular" | "bonus" | "termination" | "retro";

/** The role-derived subsidiary visibility a payroll engine caller carries. */
export type PayrollSubsidiaryScope = ReadonlySet<string> | null | undefined;

/**
 * Shared fail-closed SQL predicate for payroll engine reads. A null/undefined
 * scope is unrestricted; a present empty set matches nothing. Payroll records
 * are legal-entity-owned, so a null subsidiary never belongs to a restricted
 * caller (the same rule as the document API gate).
 */
export function payrollSubsidiaryScopeFilter(
  column: SQL,
  allowedSubsidiaryIds: PayrollSubsidiaryScope,
): SQL {
  if (allowedSubsidiaryIds == null) return sql``;
  const ids = [...allowedSubsidiaryIds];
  return ids.length > 0
    ? sql` and ${column} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
    : sql` and false`;
}

/** Predicate matching rows a restricted caller must not be allowed to read. */
export function payrollSubsidiaryOutsideScopeFilter(
  column: SQL,
  allowedSubsidiaryIds: PayrollSubsidiaryScope,
): SQL {
  if (allowedSubsidiaryIds == null) return sql`false`;
  const ids = [...allowedSubsidiaryIds];
  return ids.length > 0
    ? sql`${column} is null or ${column} not in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`
    : sql`true`;
}

/** In-memory twin for direct service guards and tests. */
export function payrollSubsidiaryInScope(
  allowedSubsidiaryIds: PayrollSubsidiaryScope,
  subsidiaryId: string | null | undefined,
): boolean {
  if (allowedSubsidiaryIds == null) return true;
  return subsidiaryId != null && subsidiaryId !== "" && allowedSubsidiaryIds.has(subsidiaryId);
}

const RUN_TYPE_MEMO: Record<PayRunType, string> = {
  regular: "Pay run",
  bonus: "Off-cycle bonus run",
  termination: "Final pay run",
  retro: "Retroactive pay run",
};

/** Run types that pay ONLY their own one-off lines: no salary, no time, no
 *  recurring components, no derived earnings, no statutory holiday pay. */
const ONE_OFF_RUN_TYPES = new Set<string>(["bonus", "retro"]);

/** Run types that must NAME the employees they pay before they can exist. */
const SCOPED_RUN_TYPES = new Set<string>(["termination", "retro"]);

/**
 * The roster a run pays, as the caller names it.
 *
 * REQUIRED on a termination run. A final pay run pays out and ZEROES every
 * accrued bank, so an unscoped one does that to the whole schedule: one person
 * quits, the operator opens a final-pay run, and every other employee receives
 * a second full period of salary and has their vacation bank drained. The
 * scope is persisted as `pay_run_adjustments` exclusion rows for everyone
 * else, which is the scope machinery the run already has.
 */
export async function createPayRun(input: {
  orgId: string; actorId: string; payScheduleId: string;
  periodStart?: string; periodEnd?: string; payDate?: string;
  /** Regular follows the schedule; bonus/termination are off-cycle. */
  runType?: PayRunType;
  /** Employees this run pays; required for `termination`, ignored otherwise. */
  employeePartyIds?: readonly string[];
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{ documentId: string; documentNumber: string }> {
  const { orgId, actorId } = input;
  return await db.transaction(async (tx) => {
    const feature = (await tx.execute<{ enabled: boolean }>(sql`
      select coalesce((settings->'features'->>'payroll')::boolean, false) as enabled
        from orgs where id = ${orgId}
    `));
    if (!feature.rows[0]?.enabled) throw new PayrollError("Payroll feature is disabled");
    const s = (await tx.execute<(ScheduleRow & { subsidiary_id: string | null })>(sql`
      select id, frequency, periods_per_year, anchor_period_end, pay_date_offset_days, subsidiary_id
        from pay_schedules where org_id = ${orgId} and id = ${input.payScheduleId} and is_active
    `));
    const schedule = s.rows[0];
    if (!schedule) throw new PayrollError("pay schedule not found");

    let periodStart = input.periodStart;
    let periodEnd = input.periodEnd;
    if (!periodStart || !periodEnd) {
      const last = (await tx.execute<{ last_end: string | null }>(sql`
        select max(period_end) as last_end from pay_runs
         where org_id = ${orgId} and pay_schedule_id = ${schedule.id}
      `));
      const next = nextPeriodAfter(schedule, last.rows[0]?.last_end ?? null);
      periodStart = next.periodStart;
      periodEnd = next.periodEnd;
    }
    const payDate = input.payDate ??
      iso(new Date(at(periodEnd).getTime() + schedule.pay_date_offset_days * DAY));

    // Scoped schedules pin the run to their legal entity (and its currency);
    // org-wide schedules keep the historical root-subsidiary behaviour.
    //
    // Resolved BEFORE the tax year, because the tax year is the country pack's
    // answer and the country is the entity's. `Number(payDate.slice(0, 4))`
    // was the calendar year of the pay date — right for the CRA and the IRS,
    // wrong for any jurisdiction whose statutory year is not the calendar one,
    // and silently so: every YTD accumulator and every year-end slip keys on
    // `tax_year`.
    const sub = (await tx.execute<{ id: string; name: string; country: string | null; currency_code: string | null }>(schedule.subsidiary_id
      ? sql`
        select s.id, s.name, s.country, s.base_currency as currency_code from subsidiaries s
         where s.org_id = ${orgId} and s.id = ${schedule.subsidiary_id} and s.is_active`
      : sql`
        select s.id, s.name, s.country, s.base_currency as currency_code from subsidiaries s
         where s.org_id = ${orgId} and s.parent_id is null and s.is_active
         order by s.created_at limit 1
    `));
    const subsidiary = sub.rows[0];
    if (!subsidiary) {
      throw new PayrollError(schedule.subsidiary_id
        ? "the pay schedule's subsidiary is missing or inactive"
        : "no active root subsidiary");
    }
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, subsidiary.id)) {
      // Match the schedule lookup's not-found response and leave the
      // transaction untouched: an out-of-scope schedule must be opaque.
      throw new PayrollError("pay schedule not found");
    }
    const runContext = resolvePayrollRunContext({
      payDate,
      subsidiary: {
        id: subsidiary.id, name: subsidiary.name,
        country: subsidiary.country, baseCurrency: subsidiary.currency_code,
      },
    });
    const taxYear = runContext.taxYear;

    // Guard 1 — no REGULAR run may overlap another regular run on the same
    // schedule: two of them covering one period would pay (and remit) the
    // period twice. Off-cycle bonus and termination runs are exempt — landing
    // inside an already-paid period is exactly what they are for.
    const runType: PayRunType = input.runType ?? "regular";
    if (runType === "regular") {
      const overlap = (await tx.execute<{ document_number: string }>(sql`
        select d.document_number from pay_runs r
          join documents d on d.id = r.document_id and d.org_id = r.org_id
         where r.org_id = ${orgId} and r.pay_schedule_id = ${schedule.id}
           and r.run_type = 'regular'
           and r.period_start <= ${periodEnd} and r.period_end >= ${periodStart}
           -- 'voided', not 'void' — the documents status enum
           -- (schema/src/documents.ts). Matching the wrong spelling made a
           -- VOIDED regular run go on blocking its own replacement.
           and d.status <> 'voided'
         limit 1
      `));
      if (overlap.rows[0]) {
        throw new PayrollError(
          `pay run ${overlap.rows[0].document_number} already covers ${periodStart} to ${periodEnd}`,
        );
      }
    }

    // Guard 2 — a run cannot be opened for a period that has not begun.
    // Processing a few days before period END is normal payroll practice;
    // opening a period that starts in the future is not, and it would compute
    // statutory amounts from time that cannot exist yet.
    const today = await businessToday(orgId);
    if (periodStart > today) {
      throw new PayrollError(
        `pay period starts ${periodStart}, which has not begun yet`,
      );
    }

    // Guard 3 — a scoped run must NAME the employees it pays. Resolved before
    // anything is written so an unscoped one cannot exist at all. A final pay
    // run pays out and clears every accrued bank; a retro run settles named
    // differences for named people. Either one loosed on a whole schedule is
    // unrecoverable.
    const scopedEmployeeIds = [...new Set(input.employeePartyIds ?? [])];
    if (SCOPED_RUN_TYPES.has(runType)) {
      if (scopedEmployeeIds.length === 0) {
        throw new PayrollError(
          runType === "termination"
            ? "a final pay run must name the employees it pays — it pays out and clears "
              + "every accrued bank, so it may never run against the whole schedule"
            : "a retroactive pay run must name the employees it pays — it settles the "
              + "differences quantified for those people, so it may never run against "
              + "the whole schedule",
        );
      }
      const onSchedule = (await tx.execute<{ employee_party_id: string }>(sql`
        select prof.employee_party_id
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
         where prof.org_id = ${orgId} and prof.pay_schedule_id = ${schedule.id} and prof.is_active
           and (${schedule.subsidiary_id}::uuid is null
                or p.subsidiary_id = ${schedule.subsidiary_id}::uuid)
      `));
      const roster = new Set(onSchedule.rows.map((row) => row.employee_party_id));
      const strangers = scopedEmployeeIds.filter((id) => !roster.has(id));
      if (strangers.length > 0) {
        throw new PayrollError(
          `${strangers.length} named employee(s) are not on this pay schedule`,
        );
      }
    }

    const seq = (await tx.execute<{ prefix: string; next_number: number; padding: number }>(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${orgId}, 'pay_run', null, 'PAY-')
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      where number_sequences.org_id = ${orgId}
      returning prefix, next_number, padding
    `));
    const number = `${seq.rows[0]!.prefix}${String(seq.rows[0]!.next_number).padStart(seq.rows[0]!.padding, "0")}`;

    const doc = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, subsidiary_id, document_date,
                             currency, status, memo, created_by, updated_by)
      values (${orgId}, 'pay_run', ${number}, ${runContext.subsidiaryId}, ${payDate},
              ${runContext.currency}, 'draft',
              ${`${RUN_TYPE_MEMO[runType]} ${periodStart} – ${periodEnd}`}, ${actorId}, ${actorId})
      returning id
    `));
    const documentId = doc.rows[0]!.id;
    await tx.execute(sql`
      insert into pay_runs (document_id, org_id, pay_schedule_id, period_start, period_end,
                            pay_date, tax_year, run_type, created_by, updated_by)
      values (${documentId}, ${orgId}, ${schedule.id}, ${periodStart}, ${periodEnd},
              ${payDate}, ${taxYear}, ${runType}, ${actorId}, ${actorId})
    `);

    // The scope, written as exclusions for everyone the run does NOT pay —
    // the mechanism `calculatePayRun` already honours, and one the operator
    // can see and adjust in the wizard like any other run adjustment.
    if (SCOPED_RUN_TYPES.has(runType)) {
      await tx.execute(sql`
        insert into pay_run_adjustments (org_id, pay_run_document_id, employee_party_id,
                                         adjustment_type, note, created_by, updated_by)
        select ${orgId}, ${documentId}, prof.employee_party_id, 'exclude',
               'Not in the final pay run''s scope', ${actorId}, ${actorId}
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
         where prof.org_id = ${orgId} and prof.pay_schedule_id = ${schedule.id} and prof.is_active
           and (${schedule.subsidiary_id}::uuid is null
                or p.subsidiary_id = ${schedule.subsidiary_id}::uuid)
           and prof.employee_party_id <> all(${`{${scopedEmployeeIds.join(",")}}`}::uuid[])
      `);
    }
    return { documentId, documentNumber: number };
  });
}

interface StubComputation {
  employeePartyId: string;
  province: string;
  gross: string;
  net: string;
  employerCost: string;
  errors: string[];
  /** Non-fatal entitlement notices (a bank at or over its scoped limit). */
  warnings: EntitlementWarning[];
}

/**
 * The transaction advisory lock that fences one employee's STATUTORY YEAR —
 * the identity two pay runs share when they can corrupt each other's
 * year-to-date, and the thing both must hold before either computes or
 * commits against it.
 *
 * Two runs for the same employee and tax year used to synchronize on nothing
 * they both held: each locked its own pay_runs row, so their calculations
 * read the same YTD base and their commits neither saw each other nor
 * waited — both posted withholdings computed from the same unconsumed
 * ceilings. Locking the RUN row cannot fix this; the fence is keyed by the
 * EMPLOYEE AND TAX YEAR both racing runs carry.
 *
 * Transaction-scoped like every advisory lock in this codebase
 * (`payroll-remittance.ts`, `fx-revaluation.ts`, `inventory.ts`), so it is
 * released at COMMIT or ROLLBACK and never leaks across the pool.
 * `calculatePayRun` takes it around every year-to-date read and
 * `commitPayRun` around its freshness gates: the second of two racing runs
 * therefore re-reads a world in which the first has already committed, and is
 * refused as stale (`payRunStaleness`'s "ytd" reason) instead of paying twice.
 */
export const employeeTaxYearFenceKey = (
  orgId: string,
  employeePartyId: string | null | undefined,
  taxYear: number | string | null | undefined,
): string => `payroll-run-ytd:${orgId}:${employeePartyId}:${taxYear}`;

/**
 * Take the fences for a run's employees, IN SORTED KEY ORDER.
 *
 * A run fences everyone on its roster, an overlapping run fences a subset of
 * it; acquiring in one deterministic order is what lets overlapping rosters
 * queue behind each other instead of deadlocking mid-set.
 */
async function takeEmployeeTaxYearFences(
  tx: Pick<typeof db, "execute">,
  keys: readonly string[],
): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

/**
 * Count the employer's employee population for jurisdiction rules that key off
 * headcount (Nebraska's special withholding procedure is one). This is not
 * the number paid on this run: an employer may have employees on another
 * schedule, and Nebraska's threshold applies to the employer as a whole.
 * The paying subsidiary is the legal-employer boundary, so employees of a
 * sibling entity can never activate this threshold accidentally.
 */
async function employerEmployeeCount(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  subsidiaryId: string,
): Promise<number> {
  const result = await tx.execute<{ employee_count: string | number }>(sql`
    select count(distinct prof.employee_party_id)::int as employee_count
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
     where prof.org_id = ${orgId}
       and prof.is_active
       and p.is_active
       and p.subsidiary_id = ${subsidiaryId}
  `);
  const count = Number(result.rows[0]?.employee_count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new PayrollError(
      `the paying employer's employee headcount is invalid (${String(result.rows[0]?.employee_count)})`,
    );
  }
  return count;
}

/**
 * Every tax certificate this employee has on file, as `resolveCertificate`
 * reads them.
 *
 * Generic: `employee_tax_certificates` is a pack-agnostic table (the pack's own
 * certificate key, the pack's own region vocabulary), so this query names no
 * country and no form. Superseded rows are LEFT IN — `resolveCertificate` picks
 * the one in force on the pay date, which is what lets a prior period re-run
 * against the certificate that was actually signed then rather than the one
 * that replaced it.
 */
async function storedTaxCertificates(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string, country: string,
): Promise<StoredCertificate[]> {
  const r = (await tx.execute<{
      certificate_key: string; answers: Record<string, string> | null;
      effective_from: string | null; superseded_on: string | null;
    }>(sql`
    select certificate_key, answers, effective_from::text as effective_from,
           superseded_on::text as superseded_on
      from employee_tax_certificates
     where org_id = ${orgId} and employee_party_id = ${employeePartyId} and country = ${country}
  `));
  return r.rows.map((row) => ({
    certificateKey: row.certificate_key,
    answers: row.answers ?? {},
    effectiveFrom: row.effective_from,
    supersededOn: row.superseded_on,
  }));
}

/**
 * Employee-scope pay rate straight from labor_cost_rates (one-table doctrine),
 * CONVERTED to the currency the run pays in.
 *
 * labor_cost_rates carries its own `currency`; the pay run is denominated in
 * its subsidiary's functional currency. Returning the raw rate and ignoring
 * the difference is not a rounding problem, it is a wrong cheque: a CAD 60.00
 * wage row paid by a USD entity paid USD 60.00 an hour — 37% over — and
 * nothing detected it, because both GL legs used the same inflated number and
 * the projection balanced perfectly.
 *
 * A missing spot rate THROWS, exactly as `recomputeCostRates` does for the
 * costing side of the same wage. Paying an unconverted wage silently is the
 * failure mode; refusing to calculate until somebody enters the rate is the
 * correct one.
 *
 * ROW SELECTION IS NOT DUPLICATED HERE. `engine/src/payroll-rate.ts` owns the
 * single definition of "which labor_cost_rates row pays this employee on this
 * date, and is it usable", because two implementations of that one rule IS the
 * defect that made readiness pass green and the run then throw. Readiness
 * builds its predicate from `effectivePayRateSql`; so does this, and the
 * salaried-needs-an-annual-row half is `payRateIsUsable` at the call site.
 * They agree because they are the same expression, not because someone kept
 * two copies in step.
 */
interface PayrollFxSource {
  id: string;
  fromCurrency: string;
  toCurrency: string;
  asOf: string;
  rate: string;
  direction: "direct" | "inverse";
  resolvedRate: string;
}

/**
 * The exact FX observation used to translate a wage, on the calculating
 * transaction rather than a pooled side read. The ordering is the same rule
 * as laborFxRate; returning the source row lets the calculation fingerprint
 * the rate instead of remembering only its rounded monetary consequence.
 */
async function resolvePayrollFxSource(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  from: string,
  to: string,
  onDate: string,
): Promise<PayrollFxSource | null> {
  if (from === to) return null;
  const result = (await tx.execute<{
      id: string; from_currency: string; to_currency: string; as_of: string;
      rate: string; direction: "direct" | "inverse"; resolved_rate: string;
    }>(sql`
    select fx.id, fx.from_currency, fx.to_currency, fx.as_of::text as as_of,
           fx.rate::text as rate,
           case when fx.from_currency = ${from} and fx.to_currency = ${to}
                then 'direct' else 'inverse' end as direction,
           case when fx.from_currency = ${from} and fx.to_currency = ${to}
                then fx.rate
                else (1 / fx.rate)::numeric(19,10) end::text as resolved_rate
      from fx_rates fx
     where fx.org_id = ${orgId} and fx.rate_type = 'spot' and fx.as_of <= ${onDate}
       and ((fx.from_currency = ${from} and fx.to_currency = ${to})
         or (fx.from_currency = ${to} and fx.to_currency = ${from}))
     order by fx.as_of desc,
              case when fx.from_currency = ${from} and fx.to_currency = ${to}
                   then 0 else 1 end
     limit 1
     for update
  `));
  const row = result.rows[0];
  return row ? {
    id: row.id,
    fromCurrency: row.from_currency,
    toCurrency: row.to_currency,
    asOf: row.as_of,
    rate: row.rate,
    direction: row.direction,
    resolvedRate: row.resolved_rate,
  } : null;
}

async function resolvePayRate(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string, onDate: string,
  /** Functional currency of the run (the run document's currency). */
  payCurrency: string | null,
): Promise<{ basis: "hour" | "year"; rate: string; annualHours: string; currency: string } | null> {
  const r = (await tx.execute<{
      id: string; basis: "hour" | "year"; rate: string;
      annual_hours: string; currency: string;
    }>(sql`
    select * from ${effectivePayRateSql({
      org: sql`${orgId}`,
      employee: sql`${employeePartyId}`,
      onDate: sql`${onDate}`,
      selectList: sql`w.id, w.basis, w.rate, w.annual_hours, w.currency`,
    })} as rate
  `));
  const selected = r.rows[0];
  if (!selected) return null;
  // Lock the exact version selected by the shared effective-rate rule. Under
  // the calculation's repeatable-read snapshot a concurrent edit either
  // waits behind this row or raises a serialization failure; it can never
  // produce a stub from one version and fingerprint another.
  const locked = (await tx.execute<{
      basis: "hour" | "year"; rate: string; annual_hours: string; currency: string;
    }>(sql`
    select basis, rate::text as rate, annual_hours::text as annual_hours, currency
      from labor_cost_rates
     where org_id = ${orgId} and id = ${selected.id}
     for update
  `));
  const row = locked.rows[0];
  if (!row) return null;
  const resolved = {
    basis: row.basis, rate: row.rate, annualHours: row.annual_hours, currency: row.currency,
  };
  if (!payCurrency || !row.currency || row.currency === payCurrency) return resolved;

  const fxSource = await resolvePayrollFxSource(tx, orgId, row.currency, payCurrency, onDate);
  if (!fxSource) {
    throw new PayrollError(
      `no spot rate for the wage ${row.currency}→${payCurrency} on or before ${onDate}`
      + " — enter one before this employee can be paid",
    );
  }
  return {
    ...resolved,
    rate: convertLaborWage(row.rate, fxSource.resolvedRate),
    currency: payCurrency,
  };
}

export interface PayRunCalculationSourceSnapshot {
  version: 1;
  timeEntries: {
    id: string;
    employeePartyId: string;
    workedOn: string;
    hours: string;
    timeTypeId: string | null;
    projectId: string | null;
    departmentId: string | null;
    isBillable: boolean;
    createdAt: string;
    updatedAt: string;
    claimable: boolean;
  }[];
  timeTypes: {
    id: string;
    name: string;
    classification: string;
    costMultiplier: string;
    excludeFromWages: boolean;
    updatedAt: string;
  }[];
  payRates: {
    employeePartyId: string;
    payBasis: string;
    runCurrency: string | null;
    rateId: string | null;
    basis: string | null;
    rate: string | null;
    annualHours: string | null;
    currency: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    updatedAt: string | null;
    fx: {
      id: string;
      fromCurrency: string;
      toCurrency: string;
      asOf: string;
      rate: string;
      direction: "direct" | "inverse";
      resolvedRate: string;
      updatedAt: string;
    } | null;
  }[];
  claimEntryIds: string[];
}

type CalculationSourceRow = {
  run_exists: boolean;
  time_entries: PayRunCalculationSourceSnapshot["timeEntries"];
  time_types: PayRunCalculationSourceSnapshot["timeTypes"];
  pay_rates: PayRunCalculationSourceSnapshot["payRates"];
  claim_entry_ids: string[];
};

/** Stable JSON independent of jsonb's object-key order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function payRunCalculationSourceDigest(
  snapshot: PayRunCalculationSourceSnapshot,
): string {
  return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}

export function parsePayRunCalculationSource(
  value: unknown,
): PayRunCalculationSourceSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Partial<PayRunCalculationSourceSnapshot>;
  if (snapshot.version !== 1
      || !Array.isArray(snapshot.timeEntries)
      || !Array.isArray(snapshot.timeTypes)
      || !Array.isArray(snapshot.payRates)
      || !Array.isArray(snapshot.claimEntryIds)) return null;
  return snapshot as PayRunCalculationSourceSnapshot;
}

/**
 * Re-derive the exact calculation population. The locked form is the commit
 * fence: every existing source row is held through the exact-ID claim and the
 * terminal transition. A new row that becomes visible after this statement's
 * PostgreSQL snapshot is later than the fence and is never claimed by this
 * run; every row visible at the fence must match the stored calculation.
 *
 * The three source CTEs deliberately share ONE SQL statement so their reads
 * cannot be torn across READ COMMITTED snapshots. Calculation runs under
 * REPEATABLE READ as an additional guarantee that these final evidence rows
 * are the same versions its earlier per-stub reads consumed.
 */
export async function payRunCalculationSource(
  orgId: string,
  documentId: string,
  executor: Pick<typeof db, "execute"> = db,
  lockSources = false,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<PayRunCalculationSourceSnapshot | null> {
  const rowLock = lockSources ? sql`for update` : sql``;
  const entryRowLock = lockSources ? sql`for update of te` : sql``;
  const result = (await executor.execute<CalculationSourceRow>(sql`
    with run_scope as materialized (
      select r.org_id, r.document_id, r.period_start, r.period_end, r.run_type,
             d.currency as run_currency, d.subsidiary_id
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
         ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
    ),
    stub_employees as materialized (
      select s.employee_party_id, prof.pay_basis, r.period_end, r.run_currency
        from run_scope r
        join pay_stubs s
          on s.org_id = r.org_id and s.pay_run_document_id = r.document_id
        left join parties p
          on p.id = s.employee_party_id and p.org_id = s.org_id
        join employee_payroll_profiles prof
          on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
       where true ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
    ),
    locked_entries as materialized (
      select te.id, te.employee_party_id, te.worked_on, te.hours, te.time_type_id,
             te.project_id, te.department_id, te.is_billable,
             te.created_at, te.updated_at,
             exists (
               select 1
                 from pay_stub_lines line
                 join pay_stubs stub
                   on stub.id = line.stub_id and stub.org_id = line.org_id
                 join pay_components component
                   on component.id = line.component_id and component.org_id = line.org_id
                where stub.org_id = r.org_id
                  and stub.pay_run_document_id = r.document_id
                  and stub.employee_party_id = te.employee_party_id
                  and component.system_key in ('base_pay', 'overtime')
                  and line.hours is not null
                  and line.time_type_id is not distinct from te.time_type_id
                  and line.project_id is not distinct from te.project_id
                  and line.department_id is not distinct from te.department_id
             ) as claimable
        from run_scope r
        join stub_employees employee on true
        join time_entries te
          on te.org_id = r.org_id and te.employee_party_id = employee.employee_party_id
         and te.status = 'approved'
         and te.worked_on between r.period_start and r.period_end
         and (te.payroll_batch_ref is null or te.payroll_batch_ref = r.document_id::text)
       where r.run_type not in ('bonus', 'retro')
       order by te.id
       ${entryRowLock}
    ),
    locked_time_types as materialized (
      select tt.id, tt.name, tt.classification, tt.cost_multiplier,
             tt.exclude_from_wages, tt.updated_at
        from time_types tt
       where tt.org_id = ${orgId}
         and exists (
           select 1 from locked_entries entry where entry.time_type_id = tt.id
         )
       order by tt.id
       ${rowLock}
    ),
    locked_rates as materialized (
      select employee.employee_party_id, employee.pay_basis,
             employee.run_currency,
             wage.id as rate_id, wage.basis, wage.rate, wage.annual_hours,
             wage.currency, wage.effective_from, wage.effective_to, wage.updated_at
        from stub_employees employee
        left join lateral (
          select w.id, w.basis, w.rate, w.annual_hours, w.currency,
                 w.effective_from, w.effective_to, w.updated_at
            from labor_cost_rates w
           where w.org_id = ${orgId}
             and w.employee_party_id = employee.employee_party_id
             and w.is_active and w.effective_from <= employee.period_end
             and (w.effective_to is null or w.effective_to >= employee.period_end)
           order by w.effective_from desc
           limit 1
           ${rowLock}
        ) wage on true
       order by employee.employee_party_id
    ),
    locked_fx as materialized (
      select rate.employee_party_id,
             fx.id, fx.from_currency, fx.to_currency, fx.as_of, fx.rate,
             case when fx.from_currency = rate.currency
                        and fx.to_currency = rate.run_currency
                  then 'direct' else 'inverse' end as direction,
             case when fx.from_currency = rate.currency
                        and fx.to_currency = rate.run_currency
                  then fx.rate
                  else (1 / fx.rate)::numeric(19,10) end as resolved_rate,
             fx.updated_at
        from locked_rates rate
        left join lateral (
          select candidate.id, candidate.from_currency, candidate.to_currency,
                 candidate.as_of, candidate.rate, candidate.updated_at
            from fx_rates candidate
           where candidate.org_id = ${orgId}
             and candidate.rate_type = 'spot'
             and candidate.as_of <= (select period_end from run_scope)
             and rate.currency is distinct from rate.run_currency
             and ((candidate.from_currency = rate.currency
                   and candidate.to_currency = rate.run_currency)
               or (candidate.from_currency = rate.run_currency
                   and candidate.to_currency = rate.currency))
           order by candidate.as_of desc,
                    case when candidate.from_currency = rate.currency
                              and candidate.to_currency = rate.run_currency
                         then 0 else 1 end
           limit 1
           ${rowLock}
        ) fx on true
    )
    select exists (select 1 from run_scope) as run_exists,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', entry.id::text,
               'employeePartyId', entry.employee_party_id::text,
               'workedOn', entry.worked_on::text,
               'hours', entry.hours::text,
               'timeTypeId', entry.time_type_id::text,
               'projectId', entry.project_id::text,
               'departmentId', entry.department_id::text,
               'isBillable', entry.is_billable,
               'createdAt', to_char(entry.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'updatedAt', to_char(entry.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'claimable', entry.claimable
             ) order by entry.id)
               from locked_entries entry
           ), '[]'::jsonb) as time_entries,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', tt.id::text,
               'name', tt.name,
               'classification', tt.classification,
               'costMultiplier', tt.cost_multiplier::text,
               'excludeFromWages', tt.exclude_from_wages,
               'updatedAt', to_char(tt.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) order by tt.id)
               from locked_time_types tt
           ), '[]'::jsonb) as time_types,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'employeePartyId', rate.employee_party_id::text,
               'payBasis', rate.pay_basis,
               'runCurrency', rate.run_currency,
               'rateId', rate.rate_id::text,
               'basis', rate.basis,
               'rate', rate.rate::text,
               'annualHours', rate.annual_hours::text,
               'currency', rate.currency,
               'effectiveFrom', rate.effective_from::text,
               'effectiveTo', rate.effective_to::text,
               'updatedAt', case when rate.updated_at is null then null else
                 to_char(rate.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
               'fx', case when fx.id is null then null else jsonb_build_object(
                 'id', fx.id::text,
                 'fromCurrency', fx.from_currency,
                 'toCurrency', fx.to_currency,
                 'asOf', fx.as_of::text,
                 'rate', fx.rate::text,
                 'direction', fx.direction,
                 'resolvedRate', fx.resolved_rate::text,
                 'updatedAt', to_char(fx.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               ) end
             ) order by rate.employee_party_id)
               from locked_rates rate
               left join locked_fx fx on fx.employee_party_id = rate.employee_party_id
           ), '[]'::jsonb) as pay_rates,
           coalesce((
             select jsonb_agg(to_jsonb(entry.id::text) order by entry.id)
               from locked_entries entry where entry.claimable
           ), '[]'::jsonb) as claim_entry_ids
  `));
  const row = result.rows[0];
  if (!row?.run_exists) return null;
  return {
    version: 1,
    timeEntries: row.time_entries ?? [],
    timeTypes: row.time_types ?? [],
    payRates: row.pay_rates ?? [],
    claimEntryIds: row.claim_entry_ids ?? [],
  };
}

export function payRunCalculationSourceChanges(
  stored: PayRunCalculationSourceSnapshot,
  current: PayRunCalculationSourceSnapshot,
): { time: boolean; timeTypes: boolean; wages: boolean } {
  return {
    time: canonicalJson(stored.timeEntries) !== canonicalJson(current.timeEntries)
      || canonicalJson(stored.claimEntryIds) !== canonicalJson(current.claimEntryIds),
    timeTypes: canonicalJson(stored.timeTypes) !== canonicalJson(current.timeTypes),
    wages: canonicalJson(stored.payRates) !== canonicalJson(current.payRates),
  };
}

/** One line of a stub, as `captureCalculatedStubs` hands it back. */
export interface CapturedStubLine {
  componentId: string | null;
  systemKey: string | null;
  kind: "earning" | "deduction" | "employer_contribution";
  description: string;
  hours: string | null;
  rate: string | null;
  amount: string;
  projectId: string | null;
  departmentId: string | null;
  timeTypeId: string | null;
  sequence: number;
}

/** One employee's whole calculated result, read back inside the transaction. */
export interface CapturedStub {
  employeePartyId: string;
  province: string;
  gross: string;
  netPay: string;
  employerCost: string;
  lines: CapturedStubLine[];
}

export interface PayRunCalculation {
  employees: number;
  errors: { employee: string; message: string }[];
  gross: string;
  net: string;
  employerCost: string;
  /**
   * The stubs the calculation produced, present ONLY for a `simulate` run.
   * Read back inside the transaction that is about to be rolled back, which is
   * the whole point: the caller gets the calculation's real output without any
   * of it surviving.
   */
  stubs?: CapturedStub[];
}

/**
 * Read a run's just-calculated stubs back, inside the calculating transaction.
 *
 * Exported because retro pay's quantification needs the LINES, not the totals:
 * "what would this period pay today" only answers the retro question when it
 * can be differenced component by component and job by job against what the
 * period actually paid (engine/src/payroll-retro.ts).
 */
export async function captureCalculatedStubs(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<CapturedStub[]> {
  const rows = (await tx.execute<Record<string, string | number | null>>(sql`
    select s.employee_party_id, s.province, s.gross, s.net_pay, s.employer_cost,
           l.component_id, c.system_key, l.kind, l.description, l.hours, l.rate, l.amount,
           l.project_id, l.department_id, l.time_type_id, l.sequence
      from pay_stubs s
      left join pay_stub_lines l on l.stub_id = s.id and l.org_id = s.org_id
      left join pay_components c on c.id = l.component_id and c.org_id = s.org_id
      left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
     order by s.employee_party_id, l.sequence, l.description
  `));
  const byEmployee = new Map<string, CapturedStub>();
  for (const row of rows.rows) {
    const employeePartyId = String(row.employee_party_id);
    let stub = byEmployee.get(employeePartyId);
    if (!stub) {
      stub = {
        employeePartyId,
        province: String(row.province ?? ""),
        gross: String(row.gross ?? "0"),
        netPay: String(row.net_pay ?? "0"),
        employerCost: String(row.employer_cost ?? "0"),
        lines: [],
      };
      byEmployee.set(employeePartyId, stub);
    }
    // A stub with no lines at all still exists as a stub; the outer join keeps
    // it, and an absent line must not be invented as a zero one.
    if (row.kind == null) continue;
    stub.lines.push({
      componentId: row.component_id == null ? null : String(row.component_id),
      systemKey: row.system_key == null ? null : String(row.system_key),
      kind: String(row.kind) as CapturedStubLine["kind"],
      description: String(row.description ?? ""),
      hours: row.hours == null ? null : String(row.hours),
      rate: row.rate == null ? null : String(row.rate),
      amount: String(row.amount ?? "0"),
      projectId: row.project_id == null ? null : String(row.project_id),
      departmentId: row.department_id == null ? null : String(row.department_id),
      timeTypeId: row.time_type_id == null ? null : String(row.time_type_id),
      sequence: Number(row.sequence ?? 0),
    });
  }
  return [...byEmployee.values()];
}

/** Rolls the calculation transaction back while carrying its result out. */
class DryRunRollback extends Error {
  constructor(readonly result: PayRunCalculation) {
    super("dry run");
  }
}

export interface CalculatePayRunInput {
  orgId: string; documentId: string; actorId: string;
  /**
   * Authoritative employee facts used by statutory holiday rules. A missing
   * fact fails closed when the employee's jurisdiction reads it; callers must
   * not let the resolver infer commission status or consent from payroll
   * amounts/timesheet gaps.
   */
  holidayEligibility?: Readonly<Record<string, StatutoryHolidayEligibilityFacts>>;
  /**
   * Compute and total the run without persisting anything — the operator sees
   * exactly what a real calculation would produce (including per-employee
   * errors) and the run stays in whatever state it was in.
   */
  dryRun?: boolean;
  /**
   * Recalculate a run that is already COMMITTED, as it would calculate today,
   * hand the caller the stubs it produced, and roll every bit of it back.
   *
   * This is what makes retroactive pay one calculation rather than two. "What
   * would this already-paid period pay under the rate that has since been
   * backdated over it" is exactly the question `calculateStub` answers, and
   * answering it a second time somewhere else would be a second definition of
   * what a period pays — which drifts, silently, in money.
   *
   * Simulation IMPLIES `dryRun` unconditionally here, not at the call site: the
   * two guards below (already committed, document not editable) are the only
   * things standing between this and rewriting a posted payroll, so the
   * rollback is not left to a caller remembering to ask for it. What the
   * transaction does — delete this run's stubs, recalculate them, read them
   * back — is discarded in full by the `DryRunRollback` throw.
   *
   * A simulation is NOT the period as it was paid. It sees today's
   * configuration by design (that is the point), and also today's year-to-date
   * position, since later runs have committed since. Statutory withholdings
   * therefore differ from the original stub and are meaningless here; retro
   * quantification differences EARNINGS only, and taxes the resulting amount
   * fresh under the pack's declared retroactive treatment.
   */
  simulate?: boolean;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}

export async function calculatePayRun(input: CalculatePayRunInput): Promise<PayRunCalculation> {
  return await calculateInTransaction(input).catch((error) => {
    if (error instanceof DryRunRollback) return error.result;
    throw error;
  });
}

async function calculateInTransaction(input: CalculatePayRunInput): Promise<PayRunCalculation> {
  const { orgId, documentId, actorId } = input;
  return await db.transaction(async (tx) => {
    const runRows = (await tx.execute<Record<string, string>>(sql`
      select r.*, d.status as doc_status, d.currency as doc_currency,
             d.subsidiary_id as doc_subsidiary_id,
             sub.name as subsidiary_name, sub.country as subsidiary_country,
             sub.base_currency as subsidiary_currency
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
        left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       -- Lock the run and its document only. The subsidiary is read-only
       -- jurisdiction context on the nullable side of an outer join, and
       -- Postgres refuses FOR UPDATE there.
       for update of r, d
    `));
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.doc_subsidiary_id)) {
      throw new PayrollError("pay run not found");
    }
    // A simulation is a rolled-back re-derivation of a run that has already
    // been paid, so these two guards are exactly what it is asking to pass;
    // everything it writes is discarded by the DryRunRollback below.
    if (!input.simulate) {
      if (run.run_status === "committed") throw new PayrollError("pay run is already committed");
      if (run.doc_status !== "draft") throw new PayrollError("pay run document is not editable");
    } else if (run.run_status !== "committed") {
      throw new PayrollError(
        "only a committed pay run can be simulated — an uncommitted one is recalculated directly",
      );
    }

    // ---- The run's jurisdiction, resolved ONCE -----------------------------
    //
    // Everything downstream — which statutory engine runs, which currency the
    // stub is denominated in, which tax authority the year-end return goes to
    // — is a consequence of WHICH LEGAL ENTITY employs these people. That was
    // never asked: `calculateStub` re-derived a country from `emp.country`
    // with `=== "US" ? "US" : "CA"`, and `subsidiaries.country` (which has
    // existed all along) was read by no payroll module at all. See
    // `resolvePayrollRunContext` in engine/src/payroll/packs.ts for the chain
    // this asserts and why it refuses instead of repairing.
    const runContext = resolvePayrollRunContext({
      payDate: run.pay_date!,
      subsidiary: {
        id: run.doc_subsidiary_id ?? "",
        name: run.subsidiary_name ?? "",
        country: run.subsidiary_country ?? null,
        baseCurrency: run.subsidiary_currency ?? null,
      },
      runCurrency: run.doc_currency ?? null,
    });
    // The run was stamped with its tax year at creation; if the pack's year
    // definition has since changed under it, every YTD accumulator on this run
    // reads a different year from the one the stubs are filed in.
    if (Number(run.tax_year) !== runContext.taxYear) {
      throw new PayrollError(
        `this pay run is stamped tax year ${run.tax_year} but a ${runContext.country} pay date of `
        + `${runContext.payDate} falls in ${runContext.taxYear}`,
      );
    }

    // Statutory holiday pay: read the gate once for the run, and provision the
    // STAT/STATPREM pair for orgs that predate them BEFORE the component map
    // is loaded — ctx.need is an assertion, never a discovery mechanism.
    const statHolidayPay = await statutoryHolidayPayEnabled(
      orgId, tx, input.allowedSubsidiaryIds,
    );
    if (statHolidayPay) {
      await ensureStatutoryHolidayComponents(
        tx, orgId, actorId, input.allowedSubsidiaryIds,
      );
    }

    // The pack's statutory components, ensured for a tenant provisioned before
    // the pack declared them — the same reason and the same idempotent path as
    // the holiday pair above. `ctx.need` is an ASSERTION, never a discovery
    // mechanism, and a levy a pack has just started emitting (state income tax)
    // must not fail every existing tenant's next payroll with "seed payroll
    // components first". Generic: it provisions whatever the run's own pack
    // declares and branches on nothing.
    await ensureComponents(tx, orgId, actorId, statutoryComponents(runContext.country));

    const components = (await tx.execute<Record<string, unknown>>(sql`
      select * from pay_components where org_id = ${orgId} and is_active order by sequence
    `));
    const byKey = new Map<string, Record<string, unknown>>();
    for (const c of components.rows) {
      if (c.system_key) byKey.set(`${c.system_key}:${c.kind}`, c);
    }
    const need = (systemKey: string, kind: string) => {
      const c = byKey.get(`${systemKey}:${kind}`);
      if (!c) throw new PayrollError(`missing system pay component ${systemKey}/${kind} — seed payroll components first`);
      return c;
    };

    // A subsidiary-scoped schedule pays only that entity's employees; an
    // org-wide schedule keeps everyone (the historical behaviour).
    const scheduleScope = (await tx.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from pay_schedules where org_id = ${orgId} and id = ${run.pay_schedule_id}
    `));
    const scopedSubsidiaryId = scheduleScope.rows[0]?.subsidiary_id ?? null;
    const runType = (run.run_type as string) ?? "regular";
    // `distinct on (p.id)` is load-bearing, not tidiness: employee_roles is
    // joined per party and a second role row would run calculateStub twice for
    // one person — a duplicate stub, doubled pay, and (because the EHT and WCB
    // accumulators below read this run's own stubs) a doubly-consumed
    // exemption. One employee, one pass, stated in the query.
    const employees = (await tx.execute<Record<string, string | null>>(sql`
      select * from (
        select distinct on (p.id)
               p.id as party_id, p.display_name, er.terminated_on,
               -- Payment rail inputs. prof.* already carries the payroll
               -- override; these are the party preference and the bank-details
               -- fact the resolver needs (engine/src/payroll-payment-method.ts).
               p.payment_method as party_payment_method,
               exists (
                 select 1 from party_bank_accounts b
                  where b.org_id = prof.org_id and b.party_id = p.id
                    and b.is_active and b.approval_status = 'approved') as has_approved_bank,
               -- The employee's OWN legal entity and the tax authority their
               -- slips file to: the other two links of the jurisdiction chain.
               -- Aliased, because prof.* below already carries a "country".
               p.subsidiary_id as employee_subsidiary_id,
               emp_sub.country as employee_subsidiary_country,
               ${effectiveFilingAccountSql("prof")} as effective_filing_account_id,
               filing_acct.country as filing_account_country,
               filing_acct.account_number as filing_account_number,
               prof.*
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
          left join subsidiaries emp_sub
            on emp_sub.id = p.subsidiary_id and emp_sub.org_id = p.org_id
          -- Aliased filing_acct, not fa: effectiveFilingAccountSql's own
          -- correlated subquery uses "fa" internally, and shadowing it here
          -- would be legal SQL that reads like a bug.
          left join payroll_filing_accounts filing_acct
            on filing_acct.id = ${effectiveFilingAccountSql("prof")}
           and filing_acct.org_id = prof.org_id
          left join employee_roles er on er.party_id = p.id and er.org_id = p.org_id
         where prof.org_id = ${orgId} and prof.pay_schedule_id = ${run.pay_schedule_id}
           and prof.is_active
           and (er.terminated_on is null or er.terminated_on >= ${run.period_start})
           and (${scopedSubsidiaryId}::uuid is null or p.subsidiary_id = ${scopedSubsidiaryId}::uuid)
           ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, input.allowedSubsidiaryIds)}
         order by p.id, er.terminated_on nulls last
      ) roster
      order by roster.display_name
    `));

    // Resolve the statutory employer headcount once for the run. It is
    // deliberately independent of this run's roster: Nebraska's special
    // procedure follows the legal employer's full population, not merely the
    // employees paid on one schedule today.
    const employerCount = await employerEmployeeCount(
      tx, orgId, runContext.subsidiaryId,
    );

    // Fence the calculation on the EMPLOYEE-AND-TAX-YEAR identity (see
    // `employeeTaxYearFenceKey`) BEFORE any year-to-date is read and before a
    // single stub row is written. Two runs sharing an employee and year used
    // to compute their statutory amounts against the same unconsumed ceilings
    // whenever their calculations overlapped; the fence orders them, so the
    // second calculation reads a year-to-date that already includes the first
    // run's stubs. Taken AFTER this run's own row lock above, in sorted key
    // order — the same total order `commitPayRun` uses — so overlapping
    // rosters queue instead of deadlocking. The roster is fenced whole (not
    // merely whoever ends up with a stub): who gets a stub is decided below,
    // and every one of these employees' YTD inputs are read on this pass.
    await takeEmployeeTaxYearFences(
      tx,
      employees.rows.map((e) => employeeTaxYearFenceKey(orgId, e.party_id, runContext.taxYear)),
    );

    await tx.execute(sql`delete from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
    // Movements are deleted with the stubs that produced them, on the same
    // key, so an employee who has dropped OFF the run (excluded, terminated,
    // moved schedule) leaves no orphaned bank movement behind. Per-employee
    // replacement inside calculateStub cannot see someone who is no longer
    // being calculated. See .local/payroll-pipeline-contract.md, "Ledger
    // writes".
    //
    // A SIMULATION writes no entitlement movements at all, and therefore
    // deletes none. Not an optimization: `entitlement_ledger` is append-only
    // once its pay run is committed (the entitlement_ledger_append_only
    // trigger), and that control is right — a bank movement backing a payroll
    // that has gone out is not editable, even inside a transaction that will
    // be rolled back. Retro quantification differences EARNINGS, and accruals
    // are `accrualOnly` employer lines that never enter that difference, so
    // suppressing the ledger writes costs the simulation nothing it uses.
    if (!input.simulate) {
      await tx.execute(sql`
        delete from entitlement_ledger
         where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
    }

    // Run-level input adjustments: exclusions drop the employee entirely;
    // 'line' rows are merged into the stub's inputs inside calculateStub.
    const excludedRows = (await tx.execute<{ employee_party_id: string }>(sql`
      select employee_party_id from pay_run_adjustments
       where org_id = ${orgId} and pay_run_document_id = ${documentId}
         and adjustment_type = 'exclude'
    `));
    const excluded = new Set(excludedRows.rows.map((r) => r.employee_party_id));

    const { eftFallbackToCheque } = await payrollPaymentMethodSettings(orgId);
    const errors: { employee: string; message: string }[] = [];
    let grossTotal = "0"; let netTotal = "0"; let employerTotal = "0"; let count = 0;
    const P = Number(run.periods_per_year ?? 0) || undefined;

    for (const emp of employees.rows) {
      if (excluded.has(emp.party_id!)) continue;
      const name = emp.display_name ?? emp.party_id!;
      // Second half of the final-pay scope guard. createPayRun writes the
      // exclusions, but the roster can GROW between creation and calculation
      // (a new hire joins the schedule), and an unexcluded stranger on a
      // termination run would be paid a full period and have every bank
      // drained. Employment that has not ended cannot be paid a final cheque:
      // refuse, by name, rather than pay.
      if (runType === "termination" && !emp.terminated_on) {
        errors.push({
          employee: name,
          message: "a final pay run pays only employees whose employment has ended — "
            + "this employee has no termination date, so they are not in its scope",
        });
        continue;
      }
      try {
        // The employee half of the chain, asserted against the run's before a
        // single statutory number is computed. A disagreement rides the
        // existing per-employee error channel, so ONE misfiled employee is
        // refused by name and the rest of the run still calculates — which is
        // what makes "correct or refused, never silently wrong" usable rather
        // than an all-or-nothing wall.
        const jurisdiction = resolveEmployeePayrollContext({
          run: runContext,
          employee: {
            partyId: emp.party_id!,
            name,
            country: emp.country!,
            region: emp.province!,
            subsidiaryId: emp.employee_subsidiary_id ?? null,
            subsidiaryCountry: emp.employee_subsidiary_country ?? null,
            filingAccountId: emp.effective_filing_account_id ?? null,
            filingAccountCountry: emp.filing_account_country ?? null,
            filingAccountNumber: emp.filing_account_number ?? null,
          },
        });
        const result = await calculateStub(tx, {
          orgId, actorId, documentId, run, emp, runContext, jurisdiction,
          periodsPerYear: P, employerEmployeeCount: employerCount, need, components: components.rows,
          eftFallbackToCheque,
          statHolidayPay,
          holidayEligibility: input.holidayEligibility,
          simulate: input.simulate === true,
          allowedSubsidiaryIds: input.allowedSubsidiaryIds,
        });
        grossTotal = add(grossTotal, result.gross);
        netTotal = add(netTotal, result.net);
        employerTotal = add(employerTotal, result.employerCost);
        count += 1;
        // A bank at or over its limit is not a calculation failure — the stub
        // is correct and the operator decides. It rides the same per-employee
        // channel the wizard already renders.
        for (const warning of result.warnings) {
          errors.push({
            employee: name,
            message: warning.kind === "over_limit"
              ? `${warning.planCode} balance ${warning.balance} exceeds its ${warning.threshold} limit`
              : `${warning.planCode} balance ${warning.balance} has reached its ${warning.threshold} notify threshold`,
          });
        }
      } catch (error) {
        errors.push({ employee: name, message: error instanceof Error ? error.message : String(error) });
      }
    }

    const result: PayRunCalculation = {
      employees: count, errors,
      gross: grossTotal, net: netTotal, employerCost: employerTotal,
    };
    // A dry run has done all the real work; throwing here discards the stubs
    // it wrote so the operator's preview costs the run nothing. A simulation is
    // a dry run whose OUTPUT is the point, so the stubs are read back first —
    // inside this transaction, immediately before it is thrown away.
    if (input.simulate) {
      result.stubs = await captureCalculatedStubs(
        tx,
        orgId,
        documentId,
        input.allowedSubsidiaryIds,
      );
      throw new DryRunRollback(result);
    }
    if (input.dryRun) throw new DryRunRollback(result);

    const calculationSource = await payRunCalculationSource(
      orgId,
      documentId,
      tx,
      true,
      input.allowedSubsidiaryIds,
    );
    if (!calculationSource) throw new PayrollError("pay run not found");
    const calculationSourceDigest = payRunCalculationSourceDigest(calculationSource);

    await tx.execute(sql`
      update pay_runs set run_status = 'calculated', calculated_at = now(),
             gross_total = ${grossTotal}, net_total = ${netTotal},
             employer_cost_total = ${employerTotal}, employee_count = ${count},
             calculation_source_snapshot = ${JSON.stringify(calculationSource)}::jsonb,
             calculation_source_digest = ${calculationSourceDigest},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
    return result;
  }, { isolationLevel: "repeatable read" });
}

/**
 * One line of a stub under construction — earnings, deductions, and employer
 * contributions alike, in the order phases append them. Hoisted to module
 * level so the jurisdiction and persistence helpers below can name it; it
 * carries no behavior, only shape.
 */
interface Line {
  componentId: string | null; kind: "earning" | "deduction" | "employer_contribution";
  description: string; hours?: string; rate?: string; amount: string;
  projectId?: string | null; departmentId?: string | null; timeTypeId?: string | null;
  sequence: number;
  taxable?: boolean; pensionable?: boolean; insurable?: boolean;
  vacationable?: boolean; nonPeriodic?: boolean; taxTreatment?: string;
  accrualOnly?: boolean;
  /**
   * Set on every pack-emitted statutory line: what the country pack declares
   * the amount is assessed on. `taxable_income` lines are dropped and
   * re-derived on each protection pass; `earnings` lines are computed once
   * and asserted unchanged (see the statutory pass below).
   */
  assessedOn?: PayrollAssessedOn;
  /** Time-type classification behind an hours line: the hours cap exempts
   *  overtime/double time charged to a job. */
  classification?: string;
  /** pay_components protection columns, carried so phase 10 needs no re-read. */
  protectionBase?: string;
  protectionMaxPercent?: string | null;
  protectionPriority?: number;
  includeInDisposableEarnings?: boolean;
}

/**
 * The run's resolved country pack, refused when it is declared but not
 * installable — statutory compute for such a country is refused, never
 * silently skipped.
 */
function installablePackOrThrow(country: string) {
  const pack = payrollPack(country);
  if (!pack.installable) {
    throw new PayrollJurisdictionError(
      `the ${country} payroll pack is declared but not installable — statutory compute is refused`,
    );
  }
  return pack;
}

/**
 * Phase 2 — statutory holiday pay lines for one employee, gated entirely on
 * JURISDICTION facts. A day's pay derived from a LOOKBACK over prior
 * earnings, plus the premium for hours actually worked on the day, where —
 * and only where — the jurisdiction declares one. The formula is a statutory
 * fact declared per jurisdiction in the country pack
 * (engine/src/payroll/packs.ts), never hardcoded here: Ontario divides four
 * weeks of regular wages plus vacation pay by 20, British Columbia divides
 * thirty days of wages by the days actually worked, Saskatchewan takes five
 * per cent.
 *
 * The caller gates on the org's settings.payroll.statutoryHolidayPay (OFF for
 * existing tenants: the phase changes gross, so it is opted into, never
 * inherited by upgrade) and on the run not being an off-cycle one-off.
 *
 * A jurisdiction NO pack has transcribed (CA-MB, US-MA) is neither guessed at
 * nor blindly refused: with no statutory holiday in the period it calculates
 * exactly as it always has, and when one lands in the period — probed against
 * the country's declared employment calendars — the run stops with the same
 * message readiness raises, naming the jurisdiction and the holiday. A silent
 * zero on a paid holiday is indistinguishable from a correct calculation,
 * which is why the refusal exists.
 *
 * Returns the earning lines to append to the stub (empty when the period has
 * no paid holiday or the jurisdiction mandates none). Throws before any line
 * is produced when the employee's labour jurisdiction cannot be honoured or
 * an undeclared jurisdiction's holiday lands in the period.
 */
export async function statutoryHolidayLinesForStub(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    documentId: string;
    employeePartyId: string;
    employeeName: string;
    /** The profile record — its labour_jurisdiction overrides the region. */
    emp: Record<string, string | null>;
    country: string;
    province: string | null;
    periodStart: string;
    periodEnd: string;
    /** The resolved labor cost rate; a salaried rate is divided to hourly here. */
    payRate: { basis: "hour" | "year"; rate: string; annualHours: string } | null;
    need: (systemKey: string, kind: string) => Record<string, unknown>;
    /** Caller role scope; null/undefined is unrestricted. */
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
    /** Authoritative statutory entitlement facts keyed by employee party id. */
    holidayEligibility?: Readonly<Record<string, StatutoryHolidayEligibilityFacts>>;
  },
): Promise<StatutoryHolidayEarningLine[]> {
  const {
    orgId, documentId, employeePartyId, employeeName,
    emp, country, province, periodStart, periodEnd, payRate, need,
    allowedSubsidiaryIds,
    holidayEligibility,
  } = args;
  if (allowedSubsidiaryIds != null) {
    const employee = (await tx.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from parties
       where org_id = ${orgId} and id = ${employeePartyId}
    `)).rows[0];
    if (!employee || !payrollSubsidiaryInScope(allowedSubsidiaryIds, employee.subsidiary_id)) {
      throw new PayrollError("employee not found");
    }
  }
  // The employment attribute wins over the region derivation where the
  // profile carries one: an employer regulated by a different labour
  // jurisdiction than the one the employee works in has a different holiday
  // calendar AND a different holiday-pay formula.
  //
  // An EXPLICIT value the packs do not declare is refused outright, not put
  // through the untranscribed-province gate below. The two are different
  // failures: an untranscribed province is a gap in the packs, and calculates
  // as it always has until a holiday actually lands in the period, whereas an
  // undeclared explicit key is a value somebody entered that means nothing —
  // it would silently fall back on the work region's calendar, which is the
  // exact substitution the attribute exists to prevent. The API validates it
  // with the same function (labourJurisdictionProblem), so reaching this is a
  // direct database write.
  const labourProblem = labourJurisdictionProblem(country, emp.labour_jurisdiction!);
  if (labourProblem) {
    throw new PayrollError(
      `${employeeName} has a labour jurisdiction this payroll cannot `
      + `honour — ${labourProblem}`,
    );
  }
  const employeeJurisdiction = jurisdictionKey(country, province, emp.labour_jurisdiction);
  if (!payrollJurisdictionDeclared(employeeJurisdiction)) {
    const conflict = undeclaredJurisdictionHolidayConflict({
      country, jurisdiction: employeeJurisdiction,
      from: periodStart, to: periodEnd,
    });
    if (conflict) throw new PayrollError(conflict.message);
    return [];
  }
  const holidayRate = payRate
    ? (payRate.basis === "hour"
        ? payRate.rate
        : divideMoney(payRate.rate, payRate.annualHours, 4))
    : "0";
  return resolveStatutoryHolidayPay(tx, {
    orgId,
    employeePartyId,
    employeeName,
    jurisdiction: employeeJurisdiction,
    periodStart,
    periodEnd,
    holidayComponentId: need("stat_holiday", "earning").id as string,
    premiumComponentId: need("stat_holiday_premium", "earning").id as string,
    excludeDocumentId: documentId,
    hourlyRate: holidayRate,
    paidOnCommission: holidayEligibility?.[employeePartyId]?.paidOnCommission,
    absentWithoutConsent: holidayEligibility?.[employeePartyId]?.absentWithoutConsent,
  });
}

/** Insert the pay_stubs header row; returns the new stub's id. */
async function insertPayStubRow(
  tx: Pick<typeof db, "execute">,
  stub: {
    orgId: string; actorId: string; documentId: string; employeePartyId: string;
    country: string; province: string; periodsPerYear: number; payDate: string; taxYear: number;
    federalClaim: string; provincialClaim: string; currency: string | null;
    gross: string; pensionable: string; insurable: string; net: string;
    employerCost: string; vacationAccrued: string;
    factors: Record<string, string>; paymentMethod: string;
  },
): Promise<string> {
  const inserted = (await tx.execute<{ id: string }>(sql`
    insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, country, country_source, province,
                           periods_per_year, pay_date, tax_year, federal_claim, provincial_claim,
                           currency_code, gross, pensionable_earnings, insurable_earnings,
                           net_pay, employer_cost, vacation_accrued, factors, payment_method,
                           created_by, updated_by)
    values (${stub.orgId}, ${stub.documentId}, ${stub.employeePartyId}, ${stub.country}, 'calculation', ${stub.province}, ${stub.periodsPerYear},
            ${stub.payDate}, ${stub.taxYear}, ${stub.federalClaim}, ${stub.provincialClaim},
            ${stub.currency}, ${stub.gross}, ${stub.pensionable}, ${stub.insurable},
            ${stub.net}, ${stub.employerCost}, ${stub.vacationAccrued}, ${JSON.stringify(stub.factors)}::jsonb,
            ${stub.paymentMethod},
            ${stub.actorId}, ${stub.actorId})
    returning id
  `));
  return inserted.rows[0]!.id;
}

/** Insert one row per stub line, in the order the phases appended them. */
async function insertPayStubLineRows(
  tx: Pick<typeof db, "execute">,
  args: { orgId: string; stubId: string; actorId: string },
  lines: readonly Line[],
): Promise<void> {
  for (const line of lines) {
    await tx.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, hours, rate,
                                  amount, project_id, department_id, time_type_id, sequence,
                                  created_by, updated_by)
      values (${args.orgId}, ${args.stubId}, ${line.componentId}, ${line.kind}, ${line.description},
              ${line.hours ?? null}, ${line.rate ?? null}, ${line.amount},
              ${line.projectId ?? null}, ${line.departmentId ?? null}, ${line.timeTypeId ?? null},
              ${line.sequence}, ${args.actorId}, ${args.actorId})
    `);
  }
}

/**
 * Ledger movements land only once the stub rows exist. The call replaces
 * THIS EMPLOYEE'S prior movements on this run and nobody else's — it is made
 * once per employee, so a run-scoped replacement here would erase every
 * previously calculated employee's bank. It runs unconditionally: an
 * employee whose recompute produced no movements must still have their stale
 * rows cleared.
 *
 * Skipped entirely for a SIMULATION: the movements of a committed run are
 * append-only (entitlement_ledger_append_only), and a rolled-back
 * re-derivation has no business rewriting the bank behind a payroll that has
 * already gone out.
 */
async function persistEntitlementMovements(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; actorId: string; documentId: string;
    employeePartyIds: [string]; simulate: boolean;
    movements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"];
  },
): Promise<void> {
  if (args.simulate) return;
  await recordEntitlementMovements(tx, {
    orgId: args.orgId, actorId: args.actorId, payRunDocumentId: args.documentId,
    employeePartyIds: args.employeePartyIds,
    movements: args.movements,
  });
}

/** Gross earning base: every earning line that is real pay. Accrual-only
 * employer lines carry no employee money and stay out of every basis. */
const earningsBase = (lines: readonly Line[]): string =>
    sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly).map((l) => l.amount));

// Hours ACTUALLY WORKED — earning lines only, matching cappableHourLines and
// the hourLines the per-hour fringe allocates across.
//
// A per-hour fringe writes its own lines carrying the hours it was assessed
// on, so summing "any line with hours" made each fringe compound the ones
// before it: with a pension and a health-and-welfare fringe on a 40-hour week,
// pension computed on 40 hours and H&W then computed on 80. Two or more
// per-hour fringes is the ordinary case in union construction, and the error
// grew with every additional one.
const totalHours = (lines: readonly Line[]): string =>
    sum(lines.filter((l) => l.kind === "earning" && l.hours).map((l) => l.hours!));

/**
 * The current earnings collapsed to one bucket per project/department — the
 * weights any job-costed employer burden allocates against. The untagged
 * bucket is deliberately included so an overhead share stays overhead
 * instead of being pushed onto whichever jobs happen to be on the stub.
 */
const earningJobBuckets = (lines: readonly Line[]): {
  projectId: string | null; departmentId: string | null; weight: string;
}[] => {
    const byDimension = new Map<string, {
      projectId: string | null; departmentId: string | null; weight: string;
    }>();
    for (const line of lines) {
      if (line.kind !== "earning" || line.accrualOnly) continue;
      const key = `${line.projectId ?? ""}|${line.departmentId ?? ""}`;
      const existing = byDimension.get(key);
      if (existing) existing.weight = add(existing.weight, line.amount);
      else {
        byDimension.set(key, {
          projectId: line.projectId ?? null,
          departmentId: line.departmentId ?? null,
          weight: line.amount,
        });
      }
    }
    return [...byDimension.values()];
};

// Hours behind a capped basis. "Overtime or double time charged to a job is
// exempt from the 40-hour cap" is a property of the hour, not of the
// component, so the predicate lives here and the engine stays pure.
const cappableHourLines = (lines: readonly Line[]) =>
    lines
      .filter((l) => l.kind === "earning" && l.hours && !l.accrualOnly)
      .map((l) => ({
        hours: l.hours!,
        amount: l.amount,
        exemptFromHoursCap:
          (l.classification === "overtime" || l.classification === "double_time")
          && l.projectId != null,
      }));

/** Every earnings-assessed line as the invariant check compares them. */
const earningsAssessedSnapshot = (lines: readonly Line[]): EarningsAssessedLine[] =>
    lines
      .filter((l) => l.assessedOn === "earnings")
      .map((l) => ({
        component: l.description,
        amount: l.amount,
        projectId: l.projectId ?? null,
        departmentId: l.departmentId ?? null,
      }));

/**
 * Periodic earnings for one stub: salary divided by the period count, or the
 * period's approved time grouped by time type × project × department and
 * priced at the effective wage. An off-cycle one-off run appends nothing —
 * its adjustments or settled retro differences carry the whole cheque.
 */
async function appendPeriodicEarnings(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string;
    run: Record<string, string>; emp: Record<string, string | null>;
    employeePartyId: string;
    payRate: Awaited<ReturnType<typeof resolvePayRate>>;
    periodsPerYear: number;
    baseComponent: Record<string, unknown>;
    oneOffRun: boolean;
    need: (systemKey: string, kind: string) => Record<string, unknown>;
    lines: Line[];
  },
): Promise<void> {
  const {
    orgId, documentId, run, emp, employeePartyId, payRate,
    periodsPerYear: P, baseComponent, oneOffRun, need, lines,
  } = args;
  if (oneOffRun) {
    // no periodic earnings — adjustments (bonus) or settled retro differences
    // (retro, immediately below) carry the whole cheque
  } else if (emp.pay_basis === "salary") {
    // Exact annual ÷ periods, rounded once (see divideMoney).
    const periodSalary = divideMoney(payRate!.rate, String(P), 2);
    lines.push({
      componentId: baseComponent.id as string, kind: "earning", description: "Salary",
      amount: periodSalary, sequence: 10,
    });
  } else {
    // Exact annual ÷ annual hours. This quotient IS the stored four-decimal
    // hourly wage, so a float reciprocal's error does not wash out — it is
    // multiplied by every hour on every stub, always the same direction.
    const hourlyWage = payRate!.basis === "hour"
      ? payRate!.rate
      : divideMoney(payRate!.rate, String(payRate!.annualHours), 4);
    const time = (await tx.execute<{
        id: string; hours: string; project_id: string | null; department_id: string | null;
        time_type_id: string | null; classification: string; multiplier: string; type_name: string;
      }>(sql`
      select te.id, te.hours, te.project_id, te.department_id, te.time_type_id,
             coalesce(tt.classification, 'regular') as classification,
             coalesce(tt.cost_multiplier, 1) as multiplier, coalesce(tt.name, 'Regular') as type_name
        from time_entries te
        left join time_types tt on tt.id = te.time_type_id and tt.org_id = te.org_id
       where te.org_id = ${orgId} and te.employee_party_id = ${employeePartyId}
         and te.status = 'approved'
         and te.worked_on between ${run.period_start} and ${run.period_end}
         and (te.payroll_batch_ref is null or te.payroll_batch_ref = ${documentId})
         and coalesce(tt.exclude_from_wages, false) = false
    `));
    const otComponent = need("overtime", "earning");
    const groups = new Map<string, { hours: string; rate: string; row: (typeof time.rows)[0] }>();
    for (const t of time.rows) {
      const key = [t.time_type_id ?? "", t.project_id ?? "", t.department_id ?? ""].join("|");
      const rate = roundMoney(mulDecimal(hourlyWage, t.multiplier), 4);
      const existing = groups.get(key);
      if (existing) existing.hours = add(existing.hours, t.hours);
      else groups.set(key, { hours: t.hours, rate, row: t });
    }
    let sequence = 10;
    for (const group of groups.values()) {
      const isOt = group.row.classification === "overtime" || group.row.classification === "double_time";
      lines.push({
        componentId: (isOt ? otComponent.id : baseComponent.id) as string,
        kind: "earning",
        description: group.row.type_name,
        hours: group.hours, rate: group.rate,
        amount: roundMoney(mulDecimal(group.rate, group.hours), 2),
        projectId: group.row.project_id, departmentId: group.row.department_id,
        timeTypeId: group.row.time_type_id, sequence: sequence++,
        classification: group.row.classification,
      });
    }
  }
}

/**
 * Phase 1b mechanics: one earning line per settled retro allocation bucket,
 * straight out of payroll_retro_allocations (dynamic import — the retro
 * module depends on this one), taxed on the pack's declared retroactive
 * treatment. Gated to retro runs by the caller's flag.
 */
async function appendRetroSettlementLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; employeePartyId: string;
    emp: Record<string, string | null>;
    country: string;
    retroRun: boolean;
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
    lines: Line[];
  },
): Promise<void> {
  const {
    orgId, documentId, employeePartyId, emp, country, retroRun, lines,
    allowedSubsidiaryIds,
  } = args;
  if (retroRun) {
    const { retroEarningLinesForStub } = await import("./payroll-retro-store.ts");
    const retroLines = await retroEarningLinesForStub(tx, {
      orgId, payRunDocumentId: documentId, employeePartyId,
      employeeName: emp.display_name ?? employeePartyId,
      nonPeriodic: payrollPack(country).retroactivePayTreatment === "non_periodic",
      allowedSubsidiaryIds,
    });
    for (const line of retroLines) {
      lines.push({
        componentId: line.componentId,
        kind: "earning",
        description: line.description,
        // Deliberately no `hours`: the source periods already paid every
        // per-hour component and union fringe on those hours, and carrying
        // them here would pay all of them a second time. The hours are on the
        // settlement rows as evidence instead.
        amount: line.amount,
        projectId: line.projectId,
        departmentId: line.departmentId,
        sequence: line.sequence,
        vacationable: line.vacationable,
        nonPeriodic: line.nonPeriodic,
      });
    }
  }
}

/** Phase 2 mechanics: rule-emitted derived earning INPUTS for the period
 *  (per diem, on-call days, travel…), resolved against the period's approved
 *  time facts. Off-cycle runs are skipped by the caller's flag. */
async function appendDerivedEarningLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string;
    run: Record<string, string>;
    employeePartyId: string;
    oneOffRun: boolean;
    lines: Line[];
  },
): Promise<void> {
  const { orgId, documentId, run, employeePartyId, oneOffRun, lines } = args;
  if (!oneOffRun) {
    const derivedRules = await loadActiveDerivedRules(tx, orgId, run.period_end!);
    if (derivedRules.length > 0) {
      // Salaried supervisors earn derived amounts too, and the hourly branch's
      // time query is scoped to wages, so read the period's facts explicitly.
      const facts = (await tx.execute<{
          id: string; worked_on: string; hours: string; time_type_id: string | null;
          project_id: string | null; department_id: string | null;
          is_billable: boolean; created_at: string | Date;
        }>(sql`
        select te.id, te.worked_on, te.hours, te.time_type_id, te.project_id,
               te.department_id, te.is_billable, te.created_at
          from time_entries te
         where te.org_id = ${orgId} and te.employee_party_id = ${employeePartyId}
           and te.status = 'approved'
           and te.worked_on between ${run.period_start} and ${run.period_end}
           and (te.payroll_batch_ref is null or te.payroll_batch_ref = ${documentId})
      `));
      const derived = await resolveDerivedEarnings(tx, {
        orgId,
        employeePartyId,
        periodStart: run.period_start!,
        periodEnd: run.period_end!,
        rules: derivedRules,
        timeEntries: facts.rows.map((fact) => ({
          id: fact.id,
          workedOn: String(fact.worked_on).slice(0, 10),
          hours: fact.hours,
          timeTypeId: fact.time_type_id,
          projectId: fact.project_id,
          departmentId: fact.department_id,
          isBillable: fact.is_billable === true,
          createdAt: fact.created_at instanceof Date
            ? fact.created_at.toISOString()
            : String(fact.created_at),
        })),
        gross: earningsBase(lines),
      });
      for (const line of derived) {
        lines.push({
          componentId: line.componentId,
          kind: "earning",
          description: line.description,
          // Deliberately no `hours`: nights and on-call days are not worked
          // hours, and hour-shaped derived quantities are already on the wage
          // lines, so carrying them here would pay per-hour components twice.
          rate: line.rate ?? undefined,
          amount: line.amount,
          projectId: line.projectId,
          departmentId: line.departmentId,
          timeTypeId: line.timeTypeId,
          sequence: line.sequence,
          taxable: line.taxable,
          pensionable: line.pensionable,
          insurable: line.insurable,
          vacationable: line.vacationable,
          nonPeriodic: line.nonPeriodic,
        });
      }
    }
  }
}

/**
 * Phase 2 mechanics: the jurisdiction-gated statutory holiday lines resolved
 * by `statutoryHolidayLinesForStub`, appended with deliberately no `hours`
 * so per-hour components and union fringes cannot be paid twice.
 */
async function appendStatutoryHolidayEarningLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; employeePartyId: string;
    emp: Record<string, string | null>;
    country: string;
    province: string;
    run: Record<string, string>;
    payRate: Awaited<ReturnType<typeof resolvePayRate>>;
    statHolidayPay: boolean;
    oneOffRun: boolean;
    need: (systemKey: string, kind: string) => Record<string, unknown>;
    lines: Line[];
    /** Caller role scope; null/undefined is unrestricted. */
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
    /** Authoritative statutory holiday eligibility facts by employee. */
    holidayEligibility?: Readonly<Record<string, StatutoryHolidayEligibilityFacts>>;
  },
): Promise<void> {
  const {
    orgId, documentId, employeePartyId, emp, country, province, run, payRate,
    statHolidayPay, oneOffRun, need, lines, allowedSubsidiaryIds, holidayEligibility,
  } = args;
  if (!oneOffRun && statHolidayPay) {
    const holidayLines = await statutoryHolidayLinesForStub(tx, {
      orgId,
      documentId,
      employeePartyId,
      employeeName: emp.display_name ?? employeePartyId,
      emp,
      country,
      province,
      periodStart: run.period_start!,
      periodEnd: run.period_end!,
      payRate,
      need,
      allowedSubsidiaryIds,
      holidayEligibility,
    });
    for (const line of holidayLines) {
      lines.push({
        componentId: line.componentId,
        kind: "earning",
        // Deliberately no `hours`: a paid day off is not worked hours, and
        // carrying them would pay per-hour components and union fringes
        // twice. The component's own flags (taxable, pensionable, insurable,
        // vacationable — all true) classify the amount: holiday pay is wages.
        description: line.description,
        amount: line.amount,
        sequence: line.sequence,
      });
    }
  }
}

/**
 * Recurring assigned components (allowances, RRSP match, dues, garnishees…):
 * basis caps applied HERE, because the cap changes the basis a percent-of-X
 * component computes on and the resulting pre-tax amount is what the
 * statutory pass consumes as T4127 factor F / U1. One-off runs pass no rows.
 */
async function applyAssignedComponentLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; employeePartyId: string;
    taxYear: number;
    documentId: string;
    assignedRows: Record<string, unknown>[];
    oneOffRun: boolean;
    lines: Line[];
  },
): Promise<void> {
  const {
    orgId, employeePartyId, taxYear, documentId, assignedRows, oneOffRun, lines,
  } = args;
/**
 * Same component's amount already taken earlier in the tax year: committed
 * stub lines PLUS the mid-year opening carry-in
 * (`payroll_opening_balance_components`). One home, in
 * payroll-opening-balances.ts, because the two halves are one fact — this
 * closure previously summed only the stubs while claiming openings arrived
 * "via the opening-balance sweep the year-end module owns", a sweep that has
 * never existed. Adoption must not hand an employee a fresh 402(g) /
 * money-purchase room.
 */
  const componentYearToDate = (componentId: string): Promise<string> =>
    openingComponentYtd(tx, {
      orgId,
      employeePartyId,
      taxYear,
      componentId,
      excludeRunDocumentId: documentId,
    });

  for (const c of oneOffRun ? [] : assignedRows) {
    const value = String(c.override ?? c.value ?? "0");
    const capped = {
      basis: c.basis as "fixed_amount" | "per_hour" | "percent_of_gross",
      value,
      basisCapHoursPerPeriod: c.basis_cap_hours_per_period as string | null,
      basisCapAmountPerPeriod: c.basis_cap_amount_per_period as string | null,
      basisCapAmountPerYear: c.basis_cap_amount_per_year as string | null,
    };
    const hasCap = capped.basisCapHoursPerPeriod != null
      || capped.basisCapAmountPerPeriod != null
      || capped.basisCapAmountPerYear != null;
    // The cap changes the basis a percent-of-X component computes on, so it
    // must run HERE: the resulting pre-tax deduction is what the statutory
    // pass consumes as T4127 factor F / U1.
    const context = hasCap
      ? {
          lines: cappableHourLines(lines),
          yearToDate: capped.basisCapAmountPerYear != null
            ? await componentYearToDate(c.id as string)
            : "0",
        }
      : {};
    let amount: string;
    if (c.basis === "per_hour") {
      amount = roundMoney(mulDecimal(value, applyBasisCaps(capped, totalHours(lines), context)), 2);
    } else if (c.basis === "percent_of_gross") {
      amount = mulPercent(applyBasisCaps(capped, earningsBase(lines), context), value, 2);
    } else {
      amount = roundMoney(applyBasisCaps(capped, value, context), 2);
    }
    if (cmp(amount, "0") === 0) continue;
    lines.push({
      componentId: c.id as string, kind: c.kind as Line["kind"],
      description: c.name as string, amount, sequence: Number(c.sequence),
      taxable: c.taxable as boolean, pensionable: c.pensionable as boolean,
      insurable: c.insurable as boolean, vacationable: c.vacationable as boolean,
      nonPeriodic: c.non_periodic as boolean, taxTreatment: c.tax_treatment as string,
      protectionBase: c.protection_base as string,
      protectionMaxPercent: c.protection_max_percent as string | null,
      protectionPriority: Number(c.protection_priority ?? 100),
      includeInDisposableEarnings: c.include_in_disposable_earnings as boolean,
    });
  }
}

/**
 * Run-level 'line' adjustments: one-off inputs for THIS employee in THIS
 * run. replaceComponent swaps out the component's derived lines (time,
 * salary, or recurring) before the one-off amount lands; either way the
 * statutory math below sees the adjusted inputs, never edited outputs.
 */
async function applyRunLineAdjustments(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; employeePartyId: string;
    bonusRun: boolean; retroRun: boolean;
    country: string;
    lines: Line[];
  },
): Promise<void> {
  const { orgId, documentId, employeePartyId, bonusRun, retroRun, country, lines } = args;
  const adjustments = (await tx.execute<Record<string, unknown>>(sql`
    select a.amount as adj_amount, a.hours as adj_hours, a.replace_component, a.note, c.*
      from pay_run_adjustments a
      join pay_components c on c.id = a.component_id and c.org_id = a.org_id
     where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
       and a.employee_party_id = ${employeePartyId} and a.adjustment_type = 'line'
     order by c.sequence, a.created_at
  `));
  for (const adj of adjustments.rows) {
    if (adj.replace_component) {
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.componentId === adj.id) lines.splice(i, 1);
      }
    }
    const amount = roundMoney(String(adj.adj_amount), 2);
    if (cmp(amount, "0") === 0) continue;
    lines.push({
      componentId: adj.id as string, kind: adj.kind as Line["kind"],
      description: (adj.note as string | null) || (adj.name as string),
      hours: adj.adj_hours != null ? String(adj.adj_hours) : undefined,
      amount, sequence: Number(adj.sequence),
      taxable: adj.taxable as boolean, pensionable: adj.pensionable as boolean,
      insurable: adj.insurable as boolean, vacationable: adj.vacationable as boolean,
      // On a bonus run every earning is non-periodic by definition: the
      // employee is not receiving this amount every period, so annualizing it
      // would over-withhold badly. On a RETRO run the same is true of a manual
      // top-up line, but the treatment is the pack's declaration rather than
      // this module's opinion — a jurisdiction that taxes retroactive pay as
      // ordinary period income declares so and gets it.
      nonPeriodic: bonusRun
        ? adj.kind === "earning"
        : retroRun
          ? adj.kind === "earning"
            && payrollPack(country).retroactivePayTreatment === "non_periodic"
          : (adj.non_periodic as boolean),
      taxTreatment: adj.tax_treatment as string,
      // A one-off garnishment entered for a single run is still a protected
      // deduction, and still belongs to (or outside) the protected base.
      protectionBase: adj.protection_base as string,
      protectionMaxPercent: adj.protection_max_percent as string | null,
      protectionPriority: Number(adj.protection_priority ?? 100),
      includeInDisposableEarnings: adj.include_in_disposable_earnings as boolean,
    });
  }
}

/**
 * Union fringes and dues under a collective agreement. Each TOTAL is
 * computed once and then allocated across jobs (`allocateProportionally`),
 * so an employer fringe and the identically-rated employee line agree to
 * the cent regardless of how hours or earnings fell across jobs.
 */
async function appendUnionFringeLines(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    emp: Record<string, string | null>;
    country: string;
    lines: Line[];
  },
): Promise<void> {
  const { orgId, emp, country, lines } = args;
  // Union fringes and dues (collective agreement)
  if (emp.union_agreement_id) {
    const { fringesForEmployee } = await import("./payroll-union.ts");
    const fringes = await fringesForEmployee(
      tx, orgId, emp.union_agreement_id, emp.union_classification_id ?? null,
    );
    for (const fringe of fringes) {
      if (!fringe.component_id) {
        throw new PayrollError(`union fringe ${fringe.code} has no linked pay component`);
      }
      const kind: Line["kind"] = fringe.paid_by === "employer" ? "employer_contribution" : "deduction";
      // The tax treatment of employee-paid dues is the PACK's declaration, not
      // a constant: 'union_dues' is a T4127 factor-U1 key, and stamping it on
      // every employee-paid fringe in every country made a CRA deduction the
      // world's default. A pack that declares null (the US — dues are post-tax
      // under the TCJA) gets dues lines with no treatment at all.
      const taxTreatment = fringe.paid_by === "employee"
        ? (payrollPack(country).employeeUnionDuesTaxTreatment ?? undefined)
        : undefined;
      // `job_costed` is a property of the FRINGE, not of how it is calculated:
      // in construction that flag exists so the fund lands on the job. Both
      // calculation shapes therefore honour it — the percent-of-gross branch
      // used to ignore it entirely and post one untagged line.
      const jobCosted = fringe.job_costed && kind === "employer_contribution";
      if (fringe.calc === "per_hour_worked") {
        // The TOTAL is computed once and then allocated, never summed from
        // independently rounded per-job amounts: $2.375/h × 10.5h is 24.94
        // whole and 24.93 as three job lines, which made an employer fringe
        // and the identically-rated employee line disagree by a cent purely
        // because of how the hours fell across jobs.
        const hours = totalHours(lines);
        const amount = roundMoney(mulDecimal(fringe.value, hours), 2);
        if (cmp(amount, "0") === 0) continue;
        const hourLines = lines.filter((l) => l.kind === "earning" && l.hours);
        const splits = jobCosted
          ? allocateProportionally(amount, hourLines.map((l) => ({ weight: l.hours!, target: l })))
          : [];
        if (splits.length > 0) {
          for (const split of splits) {
            if (cmp(split.amount, "0") === 0) continue;
            lines.push({
              componentId: fringe.component_id, kind, description: fringe.name,
              hours: split.target.hours, rate: fringe.value, amount: split.amount,
              projectId: split.target.projectId ?? null,
              departmentId: split.target.departmentId ?? null,
              sequence: 300 + fringe.sequence, taxTreatment,
            });
          }
        } else {
          lines.push({
            componentId: fringe.component_id, kind, description: fringe.name,
            hours, rate: fringe.value, amount,
            sequence: 300 + fringe.sequence, taxTreatment,
          });
        }
      } else {
        const amount = mulPercent(earningsBase(lines), fringe.value, 2);
        if (cmp(amount, "0") === 0) continue;
        // Percent-of-gross splits proportional to the earnings it is a percent
        // OF — including the untagged share, which stays untagged rather than
        // being pushed onto the jobs.
        const buckets = jobCosted ? earningJobBuckets(lines) : [];
        const splits = buckets.some((b) => b.projectId)
          ? allocateProportionally(amount, buckets.map((b) => ({ weight: b.weight, target: b })))
          : [];
        if (splits.length > 0) {
          for (const split of splits) {
            if (cmp(split.amount, "0") === 0) continue;
            lines.push({
              componentId: fringe.component_id, kind, description: fringe.name,
              amount: split.amount, sequence: 300 + fringe.sequence, taxTreatment,
              projectId: split.target.projectId, departmentId: split.target.departmentId,
            });
          }
        } else {
          lines.push({
            componentId: fringe.component_id, kind, description: fringe.name,
            amount, sequence: 300 + fringe.sequence, taxTreatment,
          });
        }
      }
    }
  }
}

/**
 * Final-pay mechanics: payout earning lines clearing every accrued bank
 * plus the matching negative ledger movements, read net of this run's own
 * movements. Skipped unless a termination run has plans to settle.
 */
async function settleTerminationBankPayouts(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; payDate: string;
    employeePartyId: string;
    terminationRun: boolean;
    plans: EntitlementPlan[];
    lines: Line[];
    entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"];
  },
): Promise<void> {
  const {
    orgId, documentId, payDate, employeePartyId,
    terminationRun, plans, lines, entitlementMovements,
  } = args;
  // A final pay must clear every accrued bank: the carried balance is paid out
  // with this period's accrual, never left on the books for someone who left.
  //
  // The balances are read INSIDE this transaction and NET OF THIS RUN'S OWN
  // movements. Both matter: without the exclusion the second Calculate saw the
  // first Calculate's `−balance` payout row, netted to zero, and silently
  // dropped the departing employee's entire accrued balance from their final
  // cheque — leaving the liability on the books with nobody to pay it to.
  if (terminationRun && plans.length > 0) {
    const balances = await entitlementBalances(orgId, employeePartyId, payDate, {
      executor: tx, excludeRunDocumentId: documentId, plans,
    });
    for (const balance of balances) {
      if (cmp(balance.balance, "0") <= 0) continue;
      if (!balance.plan.payoutComponentId) {
        throw new PayrollError(
          `entitlement plan ${balance.plan.code} has no payout component — set it in Payroll setup → Entitlement plans`,
        );
      }
      lines.push({
        componentId: balance.plan.payoutComponentId, kind: "earning",
        description: `${balance.plan.name} payout (accrued balance)`,
        amount: roundMoney(balance.balance, 2), sequence: 44, vacationable: false,
      });
      entitlementMovements.push({
        planId: balance.plan.id, employeePartyId, movementDate: payDate,
        amount: neg(roundMoney(balance.balance, 2)), hours: null,
        kind: "payout", componentId: balance.plan.payoutComponentId,
        note: "Final pay — bank cleared",
      });
    }
  }
}

/**
 * Cash-out vacation: the money is paid rather than banked, bypassing the
 * plan engine entirely and producing no ledger movement.
 */
function appendCashVacationPay(args: {
  vacationPercent: string | null;
  payVacationInCash: boolean;
  need: (systemKey: string, kind: string) => Record<string, unknown>;
  lines: Line[];
}): void {
  const { vacationPercent, payVacationInCash, need, lines } = args;
  // Cash-out vacation policies bypass the bank entirely: the money is paid,
  // not accrued, so no ledger movement is produced.
  if (payVacationInCash && vacationPercent && cmp(vacationPercent, "0") > 0) {
    const base = sum(lines
      .filter((l) => l.kind === "earning" && (l.vacationable ?? true) && !l.accrualOnly)
      .map((l) => l.amount));
    const vacation = mulPercent(base, vacationPercent, 2);
    if (cmp(vacation, "0") > 0) {
      const c = need("vacation_payout", "earning");
      lines.push({
        componentId: c.id as string, kind: "earning", description: "Vacation pay",
        amount: vacation, sequence: 45, vacationable: false,
      });
    }
  }
}

/**
 * Everything that banks: ONE engine call over the stub's bankable earning
 * lines, honouring scoped caps and service tiers, projected onto the stub
 * as accrual / payout / repayment lines and queued as ledger movements.
 * Returns the vacation accrued this period, for the stub header.
 */
async function applyEntitlementPlanMovements(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; employeePartyId: string;
    payDate: string;
    vacationPercent: string | null;
    payVacationInCash: boolean;
    vacationPlan: EntitlementPlan | null;
    plans: EntitlementPlan[];
    lines: Line[];
    entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"];
    entitlementWarnings: EntitlementWarning[];
  },
): Promise<string> {
  const {
    orgId, documentId, employeePartyId, payDate,
    vacationPercent, payVacationInCash, vacationPlan, plans,
    lines, entitlementMovements, entitlementWarnings,
  } = args;
  let vacationAccrued = "0";
  // Everything that banks: one call, honouring scoped caps and service tiers.
  if (plans.length > 0) {
    const bankablePlans = payVacationInCash && vacationPlan
      ? plans.filter((p) => p.id !== vacationPlan.id)
      : plans;
    const { movements, warnings } = await planMovementsForStub(tx, {
      orgId, employeePartyId, movementDate: payDate,
      payRunDocumentId: documentId,
      earnings: lines
        .filter((l) => l.kind === "earning" && !l.accrualOnly)
        .map((l) => ({
          componentId: l.componentId, amount: l.amount,
          hours: l.hours ?? null, bankable: l.vacationable ?? true,
        })),
      plans: bankablePlans,
      // The Vacation plan's rate has ONE home: the employee's payroll profile.
      // Its absence is an answer, not a gap — an employee with no
      // vacation_percent accrues nothing, and must not silently inherit the
      // plan's org-wide default the way a tenant-defined bank does. (A reached
      // service rung still overrides: a ladder is deliberate org policy.)
      employeeAccrualValues: vacationPlan
        ? new Map([[vacationPlan.id, String(vacationPercent ?? "0")]])
        : undefined,
    });
    entitlementWarnings.push(...warnings);
    for (const movement of movements) {
      if (!movement.componentId) continue;
      const plan = plans.find((p) => p.id === movement.planId)!;
      if (movement.kind === "accrual") {
        // Employer-side accrual: DR burden / CR the plan's liability account,
        // exactly as the old vacation_accrual line did.
        lines.push({
          componentId: movement.componentId, kind: "employer_contribution",
          description: plan.name, amount: movement.amount,
          sequence: 240, accrualOnly: true,
        });
        if (plan.systemKey === "vacation") vacationAccrued = movement.amount;
      } else if (movement.kind === "payout") {
        lines.push({
          componentId: movement.componentId, kind: "earning",
          description: `${plan.name} payout`, amount: neg(movement.amount),
          sequence: 46, vacationable: false,
        });
      } else if (movement.kind === "repayment") {
        // 'owe' plans recoup through a deduction — the employee repays what
        // the employer carried during their leave.
        lines.push({
          componentId: movement.componentId, kind: "deduction",
          description: plan.name, amount: movement.amount, sequence: 180,
        });
      }
      entitlementMovements.push(movement);
    }
  }
  return vacationAccrued;
}

/**
 * Deduction protection over the CURRENT line set, driven to settlement by
 * the caller's statutory pass: fast path, single re-cap, or the alternating
 * fixpoint (.local/payroll-pipeline-contract.md). Each pass re-caps the
 * ORIGINAL request, never the previous pass's capped amount. Returns the
 * protected orders (the live line objects), their uncapped requests, and
 * the settled result for shortfall reporting.
 */
async function settleDeductionProtection(args: {
  lines: Line[];
  gross: string;
  /** `${emp.display_name ?? partyId}`, named in the non-convergence refusal. */
  employeeLabel: string;
  runStatutoryPass: () => Promise<void>;
}) {
  const { lines, gross, employeeLabel, runStatutoryPass } = args;
  const protectedLines = lines.filter(
    (l) => l.kind === "deduction" && l.protectionBase && l.protectionBase !== "none",
  );
  // What each order asked for, captured before any pass caps it.
  const protectionRequested = protectedLines.map((l) => l.amount);

  /** Protection over the CURRENT line set — the statutory lines included. */
  const protectionPass = () => {
    const baseLines = lines.map((l) => ({
      kind: l.kind,
      amount: l.amount,
      includeInDisposableEarnings: l.includeInDisposableEarnings ?? true,
      accrualOnly: l.accrualOnly,
      protectedDeduction: protectedLines.includes(l),
    }));
    const unprotected = sum(lines
      .filter((l) => l.kind === "deduction" && !protectedLines.includes(l))
      .map((l) => l.amount));
    const available = add(gross, neg(unprotected));
    return applyDeductionProtection(
      protectedLines.map((l, index) => ({
        key: String(index),
        // Each pass re-caps the ORIGINAL request, never the previous pass's
        // capped amount — otherwise the order would ratchet down for free.
        requested: protectionRequested[index]!,
        maxPercent: l.protectionMaxPercent ?? "0",
        priority: l.protectionPriority ?? 100,
        base: protectedBase(l.protectionBase as ProtectionBase, baseLines),
      })),
      protectedBase("net_pay", baseLines),
      { available: cmp(available, "0") > 0 ? available : "0" },
    );
  };

  const applyPass = (entries: readonly { key: string; amount: string }[]) => {
    // Reducing the line IS the protection: the stub shows what was actually
    // taken, and the unpaid balance is reported, never silently dropped.
    for (const entry of entries) protectedLines[Number(entry.key)]!.amount = entry.amount;
  };

  let lastProtection: ReturnType<typeof protectionPass> | null = null;
  if (protectedLines.length === 0) {
    await runStatutoryPass();
  } else if (!protectionNeedsIteration(protectedLines.map((l) => ({ taxTreatment: l.taxTreatment })))) {
    await runStatutoryPass();
    lastProtection = protectionPass();
    applyPass(lastProtection.applied);
  } else {
    let previous = protectedLines.map((l, index) => ({ key: String(index), amount: l.amount }));
    for (let pass = 1; pass <= PROTECTION_MAX_PASSES; pass++) {
      // Withholdings computed from what the previous pass settled on, then
      // re-capped against the net pay those withholdings leave.
      applyPass(previous);
      await runStatutoryPass();
      const result = protectionPass();
      const current = result.applied.map(({ key, amount }) => ({ key, amount }));
      if (protectionConverged(previous, current)) {
        applyPass(current);
        lastProtection = result;
        break;
      }
      if (pass === PROTECTION_MAX_PASSES) {
        // Out of passes. A gap of at most a cent is the statutory engine's
        // rounding, and settles on the LOWER amount (payroll-limits.ts explains
        // the bias); anything wider is a genuine failure and must not be paid.
        const settled = settleProtectionOscillation(previous, current);
        if (!settled) {
          throw new PayrollError(
            `deduction protection did not converge for ${employeeLabel}`
            + ` on ${protectedLines.map((l) => l.description).join(", ")}`
            + ` after ${PROTECTION_MAX_PASSES} passes`,
          );
        }
        applyPass(settled);
        // The stub's withholdings must come from what is actually deducted.
        await runStatutoryPass();
        lastProtection = protectionPass();
        break;
      }
      previous = current;
    }
  }
  return { lastProtection, protectedLines, protectionRequested };
}

type ProtectionOutcome = Awaited<ReturnType<typeof settleDeductionProtection>>;

/**
 * Shortfalls are derived from what the stub FINALLY deducts, so the settle
 * branch reports the settled amount's balance rather than the last pass's.
 * Stamped into the factors map as PROT_SHORT and PROT_SHORT:<description>.
 */
function recordProtectionShortfalls(
  factors: Record<string, string>, outcome: ProtectionOutcome,
): void {
  const { lastProtection, protectedLines, protectionRequested } = outcome;
  const shortfalls: DeductionShortfall[] = [];
  const shortfallReason = new Map(
    (lastProtection?.shortfalls ?? []).map((entry) => [entry.key, entry.reason]),
  );
  for (const [index, line] of protectedLines.entries()) {
    const owed = add(protectionRequested[index]!, neg(line.amount));
    if (cmp(owed, "0") <= 0) continue;
    shortfalls.push({
      key: line.description,
      requested: protectionRequested[index]!,
      applied: line.amount,
      shortfall: owed,
      reason: shortfallReason.get(String(index)) ?? "protected_base",
    });
  }
  if (shortfalls.length > 0) {
    factors.PROT_SHORT = totalShortfall(shortfalls);
    for (const entry of shortfalls) factors[`PROT_SHORT:${entry.key}`] = entry.shortfall;
  }
}

async function calculateStub(
  tx: Pick<typeof db, "execute">,
  ctx: {
    orgId: string; actorId: string; documentId: string;
    run: Record<string, string>; emp: Record<string, string | null>;
    /** The run's resolved jurisdiction — one country, entity, currency, year. */
    runContext: PayrollRunContext;
    /** This employee's place in it, already asserted to agree with the run's. */
    jurisdiction: EmployeePayrollContext;
    periodsPerYear: number | undefined;
    employerEmployeeCount: number;
    need: (systemKey: string, kind: string) => Record<string, unknown>;
    components: Record<string, unknown>[];
    /** orgs.settings.payroll.eftFallbackToCheque, read once for the run. */
    eftFallbackToCheque: boolean;
    /** orgs.settings.payroll.statutoryHolidayPay, read once for the run. */
    statHolidayPay: boolean;
    /** Authoritative statutory holiday eligibility facts by employee. */
    holidayEligibility?: Readonly<Record<string, StatutoryHolidayEligibilityFacts>>;
    /** Rolled-back re-derivation of a COMMITTED run; writes no ledger rows. */
    simulate: boolean;
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  },
): Promise<StubComputation> {
  const { orgId, actorId, documentId, run, emp, jurisdiction } = ctx;
  const employeePartyId = emp.party_id!;
  const schedule = (await tx.execute<{ periods_per_year: number }>(sql`
    select periods_per_year from pay_schedules
     where org_id = ${orgId} and id = ${run.pay_schedule_id}
  `));
  const P = schedule.rows[0]!.periods_per_year;
  // Every one of these comes from the resolved context, not from re-reading
  // `emp` and defaulting. `country` decides which statutory engine runs;
  // `region` is the province or state it runs for; both were asserted against
  // the paying legal entity before this function was called.
  const { country, region: province } = jurisdiction;
  const taxYear = jurisdiction.taxYear;
  const pack = installablePackOrThrow(country);

  const lines: Line[] = [];
  // Entitlement movements are written to the ledger only after the stub rows
  // exist, so they can carry the stub_line_id that produced them.
  const entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"] = [];
  const entitlementWarnings: EntitlementWarning[] = [];

  const payRate = await resolvePayRate(
    tx, orgId, employeePartyId, run.period_end!, run.doc_currency ?? null,
  );
  const baseComponent = ctx.need("base_pay", "earning");

  // The employee's tax certificates, read ONCE for the stub rather than once
  // per statutory pass: the deduction-protection fixpoint runs the pass up to
  // PROTECTION_MAX_PASSES times and an employee's signed forms do not change
  // between them.
  const storedCertificates = await storedTaxCertificates(tx, orgId, employeePartyId, country);
  /**
   * One declared certificate, resolved against what is stored — the row the
   * employee signed, else the profile column that predates the model, else the
   * pack's declared default (a statutory fact, "no certificate on file is
   * withheld at single with zero allowances"), else null.
   *
   * Returns null for a certificate the pack does not declare at all, so a
   * caller asking for a form this country never issued gets an honest "no"
   * rather than an exception.
   */
  const certificateFor = (key: string): ResolvedCertificate | null => {
    let declared;
    try {
      declared = payrollCertificate(country, key);
    } catch {
      return null;
    }
    return resolveCertificate({
      certificate: declared,
      stored: storedCertificates,
      profile: emp as Record<string, unknown>,
      asOf: run.pay_date,
    });
  };

  // An off-cycle run pays only its one-off lines: no salary, no time, and no
  // recurring components (a bonus cheque does not re-take the period's benefit
  // deductions, and a retro cheque does not re-take them either — the source
  // periods already did). A bonus run's earnings are taxed on the pack's
  // non-periodic method; a retro run's treatment is the pack's DECLARATION
  // (payroll/packs.ts `retroactivePayTreatment`), never a constant here.
  const runType = (run.run_type as string) ?? "regular";
  const bonusRun = runType === "bonus";
  const retroRun = runType === "retro";
  const oneOffRun = ONE_OFF_RUN_TYPES.has(runType);

  // Is the effective rate row one the run can actually pay on? The rule lives
  // in engine/src/payroll-rate.ts and readiness asks it in SQL, so the
  // pre-flight and the run cannot disagree — which they did, before the
  // predicate had one owner: a salaried employee holding only an hourly rate
  // passed readiness green and then threw here.
  if (!oneOffRun && !payRateIsUsable(emp.pay_basis!, payRate)) {
    throw new PayrollError(payRate
      ? "salaried employee has no annual labor cost rate (employee scope)"
      : "no labor cost rate covers this employee for the period");
  }

  await appendPeriodicEarnings(tx, {
    orgId, documentId, run, emp, employeePartyId, payRate,
    periodsPerYear: P, baseComponent, oneOffRun, need: ctx.need, lines,
  });

  // Phase 1b — retroactive pay. A retro run pays the differences that were
  // QUANTIFIED and REVIEWED before it existed: one earning line per
  // (component, project, department) bucket of every settled source period,
  // straight out of payroll_retro_allocations. Those rows are both the payment
  // and the audit evidence, so there is no second copy of the amount to drift.
  //
  // Landing HERE, before the recurring components and the entitlement phases,
  // is what puts retro earnings in gross: vacation and every other entitlement
  // plan then accrues on them exactly as the plan and the component's own
  // `vacationable` flag say, with no retro-specific rule anywhere.
  //
  // The pack decides the tax treatment. Dynamic import, like the union fringe
  // phase above, so the retro module can depend on this one.
  await appendRetroSettlementLines(tx, {
    orgId,
    documentId,
    employeePartyId,
    emp,
    country,
    retroRun,
    lines,
    allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
  });

  // Recurring assigned components (allowances, RRSP match, dues, garnishees…).
  // Country-scoped components only apply to that country's employees; rows
  // with no country are shared across packs. `country` is the RESOLVED one
  // (see the destructure at the top of this function) — it used to be
  // re-derived right here as `emp.country === "US" ? "US" : "CA"`.
  const assigned = (await tx.execute<Record<string, unknown>>(sql`
    select a.value as override, c.*
      from employee_pay_components a
      join pay_components c on c.id = a.component_id and c.org_id = a.org_id
     where a.org_id = ${orgId} and a.employee_party_id = ${employeePartyId}
       and a.is_active and c.is_active and c.system_key is null
       and (c.country is null or c.country = ${country})
       and a.effective_from <= ${run.period_end}
       and (a.effective_to is null or a.effective_to >= ${run.period_end})
     order by c.sequence
  `));

  // Phase 2 — derived earnings. Per diem for nights stayed, on-call days,
  // travel pay costed to the first job of the day, site and equipment
  // incentives: money produced by operational facts rather than typed in and
  // hand-corrected. Rules emit INPUTS, exactly like time and adjustments, so
  // the statutory pass still owns every computed output.
  //
  // Off-cycle bonus runs are skipped: they pay only their one-off lines, and a
  // month_end rule landing inside an already-paid period would settle twice.
  await appendDerivedEarningLines(tx, {
    orgId, documentId, run, employeePartyId, oneOffRun, lines,
  });

  // Phase 2 — statutory holiday pay. The jurisdiction gate itself — the
  // labour-jurisdiction refusal, the undeclared-jurisdiction holiday probe,
  // the hourly-rate derivation, and the pack-declared lookback formula —
  // lives in `statutoryHolidayLinesForStub`, which returns the earning lines.
  // Landing here, before phase 3, is what puts the day's pay in gross for
  // percent-of-gross components, vacation, union fringes, WCB and the
  // statutory pass (.local/payroll-pipeline-contract.md).
  //
  // Gated on orgs.settings.payroll.statutoryHolidayPay (OFF for existing
  // tenants: the phase changes gross, so it is opted into, never inherited by
  // upgrade). Skipped on an off-cycle bonus run, which pays only its one-off
  // lines.
  await appendStatutoryHolidayEarningLines(tx, {
    orgId, documentId, employeePartyId, emp, country, province, run, payRate,
    statHolidayPay: ctx.statHolidayPay, oneOffRun, need: ctx.need, lines,
    allowedSubsidiaryIds: ctx.allowedSubsidiaryIds,
    holidayEligibility: ctx.holidayEligibility,
  });

  await applyAssignedComponentLines(tx, {
    orgId, employeePartyId, taxYear, documentId,
    assignedRows: assigned.rows, oneOffRun, lines,
  });

  // Run-level 'line' adjustments — one-off inputs for THIS employee in THIS
  // run. replaceComponent swaps out the component's derived lines (time,
  // salary, or recurring) before the one-off amount lands; either way the
  // statutory math below sees the adjusted inputs, never edited outputs.
  await applyRunLineAdjustments(tx, {
    orgId, documentId, employeePartyId, bonusRun, retroRun, country, lines,
  });

  // Union fringes and dues (collective agreement).
  await appendUnionFringeLines(tx, { orgId, emp, country, lines });

  // Phases 6 and 7 — vacation pay plus every other entitlement plan (banked
  // time, sick banks, benefit recoup) through ONE engine; see
  // engine/src/payroll-entitlements.ts.
  //
  // The employee's vacation_percent stays on the payroll profile, its one
  // home; it is handed to the Vacation plan as that employee's rate. A reached
  // service tier (5 years → 6%) overrides it. `pay_each_period` and a final pay
  // still settle in cash rather than banking, so the accrue-vs-pay decision is
  // unchanged from the operator's point of view.
  const vacationPercent = emp.vacation_percent!;
  let vacationAccrued = "0";
  const terminationRun = runType === "termination";
  const plans = await entitlementPlans(orgId, tx);
  // Resolved on the plan's ENGINE BINDING, never on its operator-typed code.
  const vacationPlan = vacationPlanOf(plans);
  assertVacationPlanResolved(emp, vacationPlan, terminationRun);

  await settleTerminationBankPayouts(tx, {
    orgId, documentId, payDate: run.pay_date!, employeePartyId,
    terminationRun, plans, lines, entitlementMovements,
  });

  const payVacationInCash = emp.vacation_method === "pay_each_period" || terminationRun;
  await appendCashVacationPay({ vacationPercent, payVacationInCash, need: ctx.need, lines });

  vacationAccrued = await applyEntitlementPlanMovements(tx, {
    orgId, documentId, employeePartyId, payDate: run.pay_date!,
    vacationPercent, payVacationInCash, vacationPlan, plans,
    lines, entitlementMovements, entitlementWarnings,
  });

  // ---- Statutory lines: one helper, one declared recomputation class -------
  //
  // Every statutory amount the packs emit goes through `pushStatutory`, which
  // asks the country pack what the amount is ASSESSED ON (packs.ts) and records
  // the answer on the line. That declaration — not which pack emitted the line,
  // and not which helper pushed it — is what decides whether the
  // deduction-protection fixpoint has to re-derive the amount:
  //
  //   earnings       — computed from gross / pensionable / insurable earnings
  //                    or hours. Protection only ever changes DEDUCTIONS, so
  //                    the amount cannot move: it is pushed ONCE and every
  //                    later pass is a no-op (which is what keeps WCB's
  //                    project split, whose last job absorbs the rounding
  //                    remainder, from being allocated a second time).
  //   taxable_income — computed from income after pre-tax deductions, so a
  //                    pre-tax protected order moves it. Dropped before each
  //                    pass and re-derived from the deductions that pass takes.
  //
  // See .local/payroll-pipeline-contract.md.
  /** Earnings-assessed slots already emitted on this stub, `systemKey:kind`. */
  const emittedEarningsAssessed = new Set<string>();

  const pushStatutory = createPushStatutory({
    country, lines, emittedEarningsAssessed, need: ctx.need,
  });

  // ---- Phase 8: pack-declared earnings-assessed employer levies ----------
  // WCB/WSIB and provincial EHT for the CA pack; other packs omit this hook.
  // Both accumulators consume against CALCULATED-OR-COMMITTED stubs — see
  // .local/payroll-pipeline-contract.md and the pack's employer-levies module.
  const employerLevies = await pack.applyEmployerLevies?.({
    tx, orgId, documentId, employeePartyId,
    employeeName: emp.display_name ?? employeePartyId,
    taxYear, region: province, lines, pushStatutory,
  }) ?? EMPTY_EMPLOYER_LEVY_FACTORS;

  // Statutory inputs from the line set. The pack's contributoryBases declaration
  // documents what pensionable and insurable accumulate for each jurisdiction.
  const earning = (predicate: (l: Line) => boolean) =>
    sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly && predicate(l)).map((l) => l.amount));
  const deduction = (treatment: string) =>
    sum(lines.filter((l) => l.kind === "deduction" && l.taxTreatment === treatment).map((l) => l.amount));

  const gross = earning(() => true);
  const income = earning((l) => (l.taxable ?? true) && !(l.nonPeriodic ?? false));
  const nonPeriodic = earning((l) => (l.taxable ?? true) && (l.nonPeriodic ?? false));
  const pensionable = earning((l) => l.pensionable ?? true);
  const insurable = earning((l) => l.insurable ?? true);

  const clearIncomeAssessedLines = () => dropIncomeAssessedLines(lines);

  const bool = (value: string | null | undefined) =>
    value === "true" || (value as unknown) === true;
  let factors: Record<string, string> = {};
  let firstEarningsAssessed: EarningsAssessedLine[] | null = null;

  const runStatutoryPass = async (): Promise<void> => {
    clearIncomeAssessedLines();
    factors = await pack.computeStatutory({
      tx, orgId, documentId, employeePartyId,
      employeeName: emp.display_name ?? employeePartyId,
      taxYear, country, region: province, run, emp,
      filingAccountId: jurisdiction.filingAccountId,
      periodsPerYear: P, employerEmployeeCount: ctx.employerEmployeeCount,
      income, nonPeriodic, pensionable, insurable, deduction,
      pushStatutory, storedCertificates, certificateFor, bool,
      assertRegionSupported: (region) => assertPayrollRegionSupported(country, region),
      employerLevies,
    });
    firstEarningsAssessed ??= earningsAssessedSnapshot(lines);
  };

  // ---- Deduction protection (protected earnings) --------------------------
  // A garnishment or support order may take only a configured share of the pay
  // it is measured against — so it is measured AFTER the statutory pass, whose
  // withholdings the base is net of.
  //
  // Two paths, and the difference is whether a protected order is pre-tax:
  //
  //   fast path  — every protected order is after-tax (an ordinary
  //                garnishment). The statutory pass is already final when
  //                protection runs, so one pass of each is exact.
  //   fixpoint   — a protected order is ALSO pre-tax (a court-ordered support
  //                payment is T4127 factor F2 AND the canonical 50%-of-net
  //                case). Capping it raises taxable income, which lowers net,
  //                which lowers the cap, so statutory and protection are run
  //                alternately until the pass's input equals its output.
  //
  // See .local/payroll-pipeline-contract.md.
  const { lastProtection, protectedLines, protectionRequested } =
    await settleDeductionProtection({
      lines, gross,
      employeeLabel: emp.display_name ?? employeePartyId,
      runStatutoryPass,
    });

  // The loop has settled: hold the pack's `earnings` declarations to their
  // word before any of it reaches the stub. A levy that moved was recomputed
  // from something a deduction changed, which is exactly the failure the
  // declaration exists to make impossible.
  assertEarningsAssessedStable(
    emp.display_name ?? employeePartyId,
    firstEarningsAssessed ?? [],
    earningsAssessedSnapshot(lines),
  );

  recordProtectionShortfalls(factors, {
    lastProtection, protectedLines, protectionRequested,
  });

  const deductions = sum(lines.filter((l) => l.kind === "deduction").map((l) => l.amount));
  const net = add(gross, neg(deductions));
  if (cmp(net, "0") < 0) throw new PayrollError(`net pay is negative (${net})`);
  const employerCost = sum(
    lines.filter((l) => l.kind === "employer_contribution").map((l) => l.amount),
  );

  // The rail is snapshotted, like the province and the claim amounts: a later
  // edit to the party or the profile must not change how a pay that has
  // already gone out is reported to have gone out.
  const paymentMethod = resolvePayrollPaymentMethod({
    profileMethod: emp.payment_method,
    partyMethod: emp.party_payment_method,
    hasApprovedBankDetails: bool(emp.has_approved_bank),
    fallbackToCheque: ctx.eftFallbackToCheque,
  }).method;

  const stubId = await insertPayStubRow(tx, {
    orgId, actorId, documentId, employeePartyId,
    country, province, periodsPerYear: P, payDate: run.pay_date!, taxYear,
    federalClaim: factors.TC ?? "0", provincialClaim: factors.TCP ?? "0",
    currency: run.doc_currency!, gross, pensionable, insurable, net,
    employerCost, vacationAccrued, factors, paymentMethod,
  });
  await insertPayStubLineRows(tx, { orgId, stubId, actorId }, lines);

  await persistEntitlementMovements(tx, {
    orgId, actorId, documentId,
    employeePartyIds: [employeePartyId],
    simulate: ctx.simulate, movements: entitlementMovements,
  });

  return {
    employeePartyId, province, gross, net, employerCost,
    errors: [], warnings: entitlementWarnings,
  };
}

export interface PayRunGlLeg {
  accountId: string;
  amount: string;
  partyId: string | null;
  projectId: string | null;
  departmentId: string | null;
  description: string;
}

/**
 * Build the balanced GL projection for a calculated run — shared by commit
 * (which writes it into document_lines) and the wizard's pre-commit preview.
 * Throws PayrollError on missing accounts or an unbalanced projection, so the
 * preview surfaces setup problems before anything is written.
 */
async function payRunGlLegs(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<{ legs: PayRunGlLeg[]; debitTotal: string }> {
  {
    const settings = await payrollSettings(orgId, allowedSubsidiaryIds);
    const costing = await laborCostingSettings(orgId);
    const control = (await tx.execute<{ c: Record<string, string | null> | null; p: Record<string, unknown> | null }>(sql`
      select settings->'controlAccounts' as c, settings->'payroll' as p from orgs where id = ${orgId}
    `));
    const laborClearing = control.rows[0]?.c?.laborClearing ?? null;
    const rawPayrollSettings = control.rows[0]?.p ?? {};

    const requireAccount = (value: string | null, label: string): string => {
      if (!value) throw new PayrollError(`payroll setup incomplete: ${label} account is not configured`);
      return value;
    };
    const wageExpense = requireAccount(settings.wageExpenseAccountId, "wage expense");
    const netPayable = requireAccount(settings.netPayAccountId, "net pay payable");
    const burdenExpense = settings.burdenExpenseAccountId ?? wageExpense;
    // Statutory liabilities are pack-declared: each seeded component carries
    // its slot's account (Payroll setup → Accounts & posting). For pre-pack
    // tenants, the SLOT's own legacySettingsKey names the old org-level
    // settings key to fall back to — the pack declares which liabilities
    // share an account (CPP2 rides the CPP payable, QPIP the EI payable);
    // this projection no longer knows any jurisdiction's mapping itself, and
    // a third pack's slot with no legacy key simply resolves to the
    // component account or a named refusal.
    const statutoryLiability = (systemKey: string | null): string | null =>
      systemKey ? legacyStatutoryLiabilityAccount(systemKey, rawPayrollSettings) : null;
    const wagesToClearing = settings.wagesTo === "labor_clearing" && costing.mode === "post";
    if (settings.wagesTo === "labor_clearing" && !laborClearing) {
      throw new PayrollError("payroll setup incomplete: labor clearing account is not configured");
    }

    const stubLines = (await tx.execute<Record<string, string | null>>(sql`
      select s.employee_party_id, l.kind, l.description, l.amount, l.project_id, l.department_id,
             c.system_key, c.expense_account_id, c.liability_account_id, s.net_pay
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
        left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
       where l.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
         ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
       order by s.employee_party_id, l.sequence
    `));
    if (stubLines.rows.length === 0) throw new PayrollError("pay run has no calculated stubs");

    // Aggregate GL legs: key = account|project|department|party (party only on net pay)
    const legs = new Map<string, {
      accountId: string; amount: string; partyId: string | null;
      projectId: string | null; departmentId: string | null; description: string;
    }>();
    const accumulate = (
      accountId: string, amount: string, description: string,
      opts: { partyId?: string | null; projectId?: string | null; departmentId?: string | null } = {},
    ) => {
      if (cmp(amount, "0") === 0) return;
      const key = [accountId, opts.partyId ?? "", opts.projectId ?? "", opts.departmentId ?? ""].join("|");
      const existing = legs.get(key);
      if (existing) existing.amount = add(existing.amount, amount);
      else legs.set(key, {
        accountId, amount, description,
        partyId: opts.partyId ?? null, projectId: opts.projectId ?? null,
        departmentId: opts.departmentId ?? null,
      });
    };

    const netByEmployee = new Map<string, string>();
    for (const line of stubLines.rows) {
      netByEmployee.set(line.employee_party_id!, line.net_pay!);
      const amount = line.amount!;
      if (line.kind === "earning") {
        const isTimeDriven = line.system_key === "base_pay" || line.system_key === "overtime";
        if (isTimeDriven && wagesToClearing) {
          // Standard cost already posted to the job at approval; wash clearing.
          accumulate(laborClearing!, amount, "Wages (labor clearing)");
        } else {
          accumulate(line.expense_account_id ?? wageExpense, amount, line.description ?? "Wages", {
            projectId: line.project_id, departmentId: line.department_id,
          });
        }
      } else if (line.kind === "deduction") {
        const liability = line.liability_account_id ?? statutoryLiability(line.system_key ?? null);
        if (!liability) {
          throw new PayrollError(
            `deduction "${line.description}" has no liability account — set it in Payroll setup → Accounts & posting`,
          );
        }
        accumulate(liability, neg(amount), line.description ?? "Deduction");
      } else {
        const liability = line.liability_account_id ?? statutoryLiability(line.system_key ?? null);
        if (!liability) {
          throw new PayrollError(
            `employer contribution "${line.description}" has no liability account — set it in Payroll setup → Accounts & posting`,
          );
        }
        // Job-costed burdens (union fringes) carry the line's project split.
        accumulate(line.expense_account_id ?? burdenExpense, amount, line.description ?? "Employer burden", {
          projectId: line.project_id, departmentId: line.department_id,
        });
        accumulate(liability, neg(amount), line.description ?? "Employer burden");
      }
    }
    for (const [employeePartyId, net] of netByEmployee) {
      accumulate(netPayable, neg(net), "Net pay", { partyId: employeePartyId });
    }

    const total = sum([...legs.values()].map((l) => l.amount));
    if (cmp(total, "0") !== 0) throw new PayrollError(`pay run GL projection is unbalanced (${total})`);
    const debitTotal = sum([...legs.values()].filter((l) => cmp(l.amount, "0") > 0).map((l) => l.amount));
    return { legs: [...legs.values()], debitTotal };
  }
}

/**
 * Commit: materialize the balanced GL projection into document_lines and claim
 * the period's time entries. The document then posts through the standard
 * submit/post action (RULES.pay_run maps lines 1:1, signed, like a journal).
 *
 * Freshness is enforced HERE, on this transaction's own read — not only by
 * the route's pre-flight and the wizard's disabled button. A run whose inputs
 * changed after Calculate is refused before anything is written, which is
 * what keeps newly approved time from being claimed by a stub that never
 * priced it.
 */
export async function commitPayRun(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{ lines: number }> {
  const { orgId, documentId, actorId } = input;
  return await db.transaction(async (tx) => {
    const runRows = (await tx.execute<Record<string, string>>(sql`
      select r.*, d.status as doc_status, d.subsidiary_id as subsidiary_id from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      where r.org_id = ${orgId} and r.document_id = ${documentId} for update
    `));
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id)) {
      throw new PayrollError("pay run not found");
    }
    if (run.run_status !== "calculated") throw new PayrollError("calculate the pay run before committing");
    // Approval moves the document from draft to approved, so both are
    // committable; anything else (posted, voided) is not.
    if (run.doc_status !== "draft" && run.doc_status !== "approved") {
      throw new PayrollError("pay run document is not editable");
    }
    // Fence the commit on the EMPLOYEE-AND-TAX-YEAR identity every racing run
    // must hold (see `employeeTaxYearFenceKey`) — not on this run's own row,
    // which a concurrent same-year run never contends on. Taken BEFORE the
    // freshness gate below, so the gate's answer describes the world as of
    // THIS RUN'S TURN IN THE FENCE ORDER: if another run for one of these
    // employees committed while this transaction waited, the gate sees its
    // committed stubs ("ytd" staleness) and refuses, which is exactly what
    // makes exactly ONE of two racing runs able to commit. Sorted key order —
    // the order `calculatePayRun` already acquires in — so overlapping
    // rosters queue instead of deadlocking mid-set.
    const fencedEmployees = (await tx.execute<{ employee_party_id: string }>(sql`
      select distinct s.employee_party_id
        from pay_stubs s
       where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
    `));
    await takeEmployeeTaxYearFences(
      tx,
      fencedEmployees.rows.map((e) =>
        employeeTaxYearFenceKey(orgId, e.employee_party_id, run.tax_year),
      ),
    );
    // Historical component policy changes and deletes take the component
    // row's write lock. Hold the same rows through freshness and commit:
    // a later editor waits, then the database history guard sees the committed
    // run; an earlier editor finishes before this transaction checks freshness.
    await tx.execute(sql`
      select c.id from pay_components c
       where c.org_id = ${orgId} and exists (
         select 1 from pay_stub_lines l
         join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          where l.org_id = c.org_id and l.component_id = c.id
            and s.pay_run_document_id = ${documentId}
       )
       order by c.id for share of c
    `);
    // The freshness gate, asked ON THIS TRANSACTION so an engine caller that
    // skips the route's pre-flight gets the same refusal, against the same
    // snapshot the claim below will run under. Dynamic import keeps the
    // payroll-run ↔ payroll-readiness cycle out of the engine's load order
    // (same idiom as the approval gate just below).
    const { assertPayRunNotStale, staleCalculationMessage } =
      await import("./payroll-readiness.ts");
    await assertPayRunNotStale(orgId, documentId, tx, input.allowedSubsidiaryIds);
    // Money must not move before the run is approved. Dynamic import keeps the
    // module cycle out of the engine's load order (same idiom as
    // flows/documents-adapter.ts → document-void.ts).
    const { assertPayRunApprovalReleased } = await import("./payroll-approval.ts");
    await assertPayRunApprovalReleased(orgId, documentId);

    // Recompute and lock the canonical source population before producing a
    // single GL line. Legacy calculated rows have no evidence and therefore
    // require recalculation; a corrupt snapshot/digest pair fails the same
    // closed way. Category-specific reasons preserve the wizard/API contract.
    const storedSource = parsePayRunCalculationSource(run.calculation_source_snapshot);
    const storedDigest = run.calculation_source_digest ?? null;
    if (!storedSource || !storedDigest
        || payRunCalculationSourceDigest(storedSource) !== storedDigest) {
      throw new PayrollError(staleCalculationMessage(["selection"]));
    }
    const currentSource = await payRunCalculationSource(
      orgId,
      documentId,
      tx,
      true,
      input.allowedSubsidiaryIds,
    );
    if (!currentSource) throw new PayrollError("pay run not found");
    const changes = payRunCalculationSourceChanges(storedSource, currentSource);
    const sourceReasons = [
      changes.time ? "time" : null,
      changes.timeTypes ? "timeTypes" : null,
      changes.wages ? "wages" : null,
    ].filter((reason): reason is string => reason !== null);
    if (payRunCalculationSourceDigest(currentSource) !== storedDigest) {
      throw new PayrollError(staleCalculationMessage(
        sourceReasons.length > 0 ? sourceReasons : ["selection"],
      ));
    }

    const { legs, debitTotal } = await payRunGlLegs(
      tx,
      orgId,
      documentId,
      input.allowedSubsidiaryIds,
    );

    await tx.execute(sql`delete from document_lines where org_id = ${orgId} and document_id = ${documentId}`);
    let lineNumber = 1;
    for (const leg of legs) {
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    amount, party_id, project_id, department_id, created_by, updated_by)
        values (${orgId}, ${documentId}, ${lineNumber++}, ${leg.accountId}, ${leg.description},
                ${leg.amount}, ${leg.partyId}, ${leg.projectId}, ${leg.departmentId},
                ${actorId}, ${actorId})
      `);
    }

    // Claim the calculation's exact IDs — never a rediscovered employee/group
    // population. The compare above proves these locked rows are unchanged;
    // the update's own predicates and returned-ID equality are defense in
    // depth against corruption or a future caller weakening that lock.
    const claimed = (await tx.execute<{ id: string }>(sql`
      with selected as (
        select value::uuid as id
          from jsonb_array_elements_text(
            ${JSON.stringify(storedSource.claimEntryIds)}::jsonb
          ) entry(value)
      )
      update time_entries te
         set payroll_batch_ref = ${documentId}
        from selected
       where te.id = selected.id and te.org_id = ${orgId}
         and te.status = 'approved'
         and te.worked_on between ${run.period_start} and ${run.period_end}
         and te.payroll_batch_ref is null
      returning te.id::text as id
    `));
    const expectedClaimIds = [...storedSource.claimEntryIds].sort();
    const actualClaimIds = claimed.rows.map((row) => row.id).sort();
    if (canonicalJson(actualClaimIds) !== canonicalJson(expectedClaimIds)) {
      throw new PayrollError(staleCalculationMessage(["time"]));
    }
    // Belt AND braces, deliberately — the same doctrine as the gate that
    // opened this transaction, now asked again at the LAST moment. The two
    // gates are separate statements and READ COMMITTED gives each its own
    // snapshot, so the first gate's answer cannot see what commits after it:
    // a wage row, a rate, a plan, org settings, or ANOTHER RUN'S COMMIT could
    // land in the gap between check and terminal write and ride under a
    // freshness answer that was true when it was taken. The fences above
    // order two racing COMMITS against each other; this second read closes
    // the remaining gap for every OTHER writer — anything committed before
    // this statement executes is SEEN by it (fresh snapshot), and the run is
    // refused and recalculated instead of posting figures edited past. Only
    // writes committing after this statement stay outside it, exactly as the
    // time claim above leaves them unclaimed for the next calculation.
    await assertPayRunNotStale(orgId, documentId, tx, input.allowedSubsidiaryIds);
    await tx.execute(sql`
      update pay_runs set run_status = 'committed', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
    await tx.execute(sql`
      update documents set subtotal = ${debitTotal}, total = ${debitTotal},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${documentId}
    `);
    return { lines: legs.length };
  });
}

/**
 * Pre-commit GL preview: the exact legs commit would write, enriched with
 * account/party/project names for the wizard's review step. Read-only —
 * setup problems (missing accounts, imbalance) surface as PayrollError here
 * before anything is written.
 */
export async function previewPayRunGl(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<{ legs: (PayRunGlLeg & {
  accountLabel: string; partyName: string | null; projectName: string | null;
})[]; debitTotal: string }> {
  const runRows = (await db.execute<{ run_status: string; subsidiary_id: string | null }>(sql`
    select r.run_status, d.subsidiary_id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `));
  if (!runRows.rows[0]) throw new PayrollError("pay run not found");
  if (runRows.rows[0].run_status === "draft") {
    throw new PayrollError("calculate the pay run to preview its GL impact");
  }
  const { legs, debitTotal } = await payRunGlLegs(
    db,
    orgId,
    documentId,
    allowedSubsidiaryIds,
  );
  const accountIds = [...new Set(legs.map((l) => l.accountId))];
  const partyIds = [...new Set(legs.map((l) => l.partyId).filter(Boolean))] as string[];
  const projectIds = [...new Set(legs.map((l) => l.projectId).filter(Boolean))] as string[];
  const [accounts, parties, projects] = (await Promise.all([
    db.execute<{ id: string; number: string | null; name: string }>(sql`select id, number, name from accounts
                    where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`),
    partyIds.length
      ? db.execute<{ id: string; display_name: string }>(sql`select id, display_name from parties
                        where org_id = ${orgId} and id = any(${`{${partyIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
    projectIds.length
      ? db.execute<{ id: string; name: string }>(sql`select id, name from projects
                        where org_id = ${orgId} and id = any(${`{${projectIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
  ]));
  const accountById = new Map(accounts.rows.map((a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name]));
  const partyById = new Map(parties.rows.map((p) => [p.id, p.display_name]));
  const projectById = new Map(projects.rows.map((p) => [p.id, p.name]));
  return {
    debitTotal,
    legs: legs.map((leg) => ({
      ...leg,
      accountLabel: accountById.get(leg.accountId) ?? leg.accountId,
      partyName: leg.partyId ? (partyById.get(leg.partyId) ?? null) : null,
      projectName: leg.projectId ? (projectById.get(leg.projectId) ?? null) : null,
    })),
  };
}
