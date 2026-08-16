import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  add, cmp, fromUnits, mulDecimal, mulPercent, mulRatio, neg, roundDiv, roundMoney, sum, toUnits,
} from "./money.ts";
import { calculateT4127, type T4127Input } from "./payroll/canada/t4127.ts";
import { calculateTp1015 } from "./payroll/canada/quebec/tp1015.ts";
import type { Province } from "./payroll/canada/rates.ts";
import { calculatePub15T } from "./payroll/us/pub15t.ts";
import {
  assertContributoryBasesDeclared,
  assertPayrollRegionSupported,
  jurisdictionKey,
  legacyStatutoryLiabilityAccount,
  packStatutoryComponents,
  payrollJurisdictionDeclared,
  payrollPack,
  resolveEmployeePayrollContext,
  resolvePayrollRunContext,
  statutoryAssessment,
  type EmployeePayrollContext,
  type PayrollAssessedOn,
  type PayrollRunContext,
} from "./payroll/packs.ts";
import {
  resolveStatutoryHolidayPay,
  undeclaredJurisdictionHolidayConflict,
} from "./payroll-holidays.ts";
import { effectivePayRateSql, payRateIsUsable } from "./payroll-rate.ts";
import { effectiveFilingAccountSql } from "./payroll-filing.ts";
import { laborCostingSettings } from "./labor-costing.ts";
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

/**
 * US pack org configuration (orgs.settings.payroll.us): the effective FUTA
 * rate (credit-reduction states raise it past the default 0.6%) and the
 * employer's state unemployment accounts — SUI rates are experience-rated
 * per employer, so they are org-entered settings, never engine constants.
 */
export interface UsPayrollConfig {
  futaRate: string | null;
  sui: Record<string, { rate: string; wageBase: string }>;
}

export async function usPayrollConfig(orgId: string): Promise<UsPayrollConfig> {
  const r = (await db.execute(
    sql`select settings#>'{payroll,us}' as u from orgs where id = ${orgId}`,
  )) as unknown as { rows: { u: Record<string, unknown> | null }[] };
  const u = r.rows[0]?.u ?? {};
  const sui: UsPayrollConfig["sui"] = {};
  const rawSui = (u.sui ?? {}) as Record<string, { rate?: unknown; wageBase?: unknown }>;
  for (const [state, entry] of Object.entries(rawSui)) {
    if (entry && entry.rate != null && entry.wageBase != null) {
      sui[state] = { rate: String(entry.rate), wageBase: String(entry.wageBase) };
    }
  }
  return { futaRate: u.futaRate != null ? String(u.futaRate) : null, sui };
}

/**
 * CA pack org configuration (orgs.settings.payroll.ca). EHT is an org-level
 * payroll tax on Ontario remuneration past the annual exemption; WCB rates
 * live on worker_comp_groups (per class), so only the toggle lives here.
 */
export interface CaPayrollConfig {
  eht: { enabled: boolean; rate: string | null; annualExemption: string | null };
}

export async function caPayrollConfig(orgId: string): Promise<CaPayrollConfig> {
  const r = (await db.execute(
    sql`select settings#>'{payroll,ca}' as c from orgs where id = ${orgId}`,
  )) as unknown as { rows: { c: Record<string, unknown> | null }[] };
  const c = (r.rows[0]?.c ?? {}) as { eht?: { enabled?: unknown; rate?: unknown; annualExemption?: unknown } };
  return {
    eht: {
      enabled: c.eht?.enabled === true,
      rate: c.eht?.rate != null ? String(c.eht.rate) : null,
      annualExemption: c.eht?.annualExemption != null ? String(c.eht.annualExemption) : null,
    },
  };
}

export async function payrollSettings(orgId: string): Promise<PayrollSettings> {
  const r = (await db.execute(
    sql`select settings->'payroll' as p, settings->'controlAccounts' as c from orgs where id = ${orgId}`,
  )) as unknown as { rows: { p: Record<string, unknown> | null; c: Record<string, unknown> | null }[] };
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

export class PayrollError extends Error {}

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
): Promise<void> {
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
): Promise<void> {
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
  orgId: string, executor: Pick<typeof db, "execute"> = db,
): Promise<boolean> {
  const r = (await executor.execute(sql`
    select settings#>>'{payroll,statutoryHolidayPay}' as enabled from orgs where id = ${orgId}
  `)) as unknown as { rows: { enabled: string | null }[] };
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
  const modal = (await db.execute(sql`
    select vacation_percent::text as percent
      from employee_payroll_profiles
     where org_id = ${orgId} and vacation_percent is not null and vacation_percent > 0
     group by vacation_percent
     order by count(*) desc, vacation_percent asc
     limit 1
  `)) as unknown as { rows: { percent: string }[] };
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

interface ScheduleRow {
  id: string; frequency: string; periods_per_year: number;
  anchor_period_end: string; pay_date_offset_days: number;
}

const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (s: string) => new Date(`${s}T00:00:00Z`);

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
    // Periods end on the 15th and the last day of each month.
    const boundaries = (y: number, m: number) => [
      new Date(Date.UTC(y, m, 15)), new Date(Date.UTC(y, m + 1, 0)),
    ];
    let cursor = lastPeriodEnd ? at(lastPeriodEnd) : new Date(anchor.getTime() - DAY);
    for (let m = 0; m < 26; m++) {
      const base = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + Math.floor(m / 2), 1));
      const end = boundaries(base.getUTCFullYear(), base.getUTCMonth())[m % 2]!;
      if (end.getTime() > cursor.getTime()) {
        const start = end.getUTCDate() === 15
          ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
          : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 16));
        return { periodStart: iso(start), periodEnd: iso(end) };
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

export type PayRunType = "regular" | "bonus" | "termination";

const RUN_TYPE_MEMO: Record<PayRunType, string> = {
  regular: "Pay run",
  bonus: "Off-cycle bonus run",
  termination: "Final pay run",
};

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
}): Promise<{ documentId: string; documentNumber: string }> {
  const { orgId, actorId } = input;
  return await db.transaction(async (tx) => {
    const s = (await tx.execute(sql`
      select id, frequency, periods_per_year, anchor_period_end, pay_date_offset_days, subsidiary_id
        from pay_schedules where org_id = ${orgId} and id = ${input.payScheduleId} and is_active
    `)) as unknown as { rows: (ScheduleRow & { subsidiary_id: string | null })[] };
    const schedule = s.rows[0];
    if (!schedule) throw new PayrollError("pay schedule not found");

    let periodStart = input.periodStart;
    let periodEnd = input.periodEnd;
    if (!periodStart || !periodEnd) {
      const last = (await tx.execute(sql`
        select max(period_end) as last_end from pay_runs
         where org_id = ${orgId} and pay_schedule_id = ${schedule.id}
      `)) as unknown as { rows: { last_end: string | null }[] };
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
    const sub = (await tx.execute(schedule.subsidiary_id
      ? sql`
        select s.id, s.name, s.country, s.base_currency as currency_code from subsidiaries s
         where s.org_id = ${orgId} and s.id = ${schedule.subsidiary_id} and s.is_active`
      : sql`
        select s.id, s.name, s.country, s.base_currency as currency_code from subsidiaries s
         where s.org_id = ${orgId} and s.parent_id is null and s.is_active
         order by s.created_at limit 1
    `)) as unknown as {
      rows: { id: string; name: string; country: string | null; currency_code: string | null }[];
    };
    const subsidiary = sub.rows[0];
    if (!subsidiary) {
      throw new PayrollError(schedule.subsidiary_id
        ? "the pay schedule's subsidiary is missing or inactive"
        : "no active root subsidiary");
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
      const overlap = (await tx.execute(sql`
        select d.document_number from pay_runs r
          join documents d on d.id = r.document_id
         where r.org_id = ${orgId} and r.pay_schedule_id = ${schedule.id}
           and r.run_type = 'regular'
           and r.period_start <= ${periodEnd} and r.period_end >= ${periodStart}
           -- 'voided', not 'void' — the documents status enum
           -- (schema/src/documents.ts). Matching the wrong spelling made a
           -- VOIDED regular run go on blocking its own replacement.
           and d.status <> 'voided'
         limit 1
      `)) as unknown as { rows: { document_number: string }[] };
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
    const today = iso(new Date());
    if (periodStart > today) {
      throw new PayrollError(
        `pay period starts ${periodStart}, which has not begun yet`,
      );
    }

    // Guard 3 — a final pay run must NAME the employees it pays. Resolved
    // before anything is written so an unscoped one cannot exist at all.
    const scopedEmployeeIds = [...new Set(input.employeePartyIds ?? [])];
    if (runType === "termination") {
      if (scopedEmployeeIds.length === 0) {
        throw new PayrollError(
          "a final pay run must name the employees it pays — it pays out and clears "
          + "every accrued bank, so it may never run against the whole schedule",
        );
      }
      const onSchedule = (await tx.execute(sql`
        select prof.employee_party_id
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
         where prof.org_id = ${orgId} and prof.pay_schedule_id = ${schedule.id} and prof.is_active
           and (${schedule.subsidiary_id}::uuid is null
                or p.subsidiary_id = ${schedule.subsidiary_id}::uuid)
      `)) as unknown as { rows: { employee_party_id: string }[] };
      const roster = new Set(onSchedule.rows.map((row) => row.employee_party_id));
      const strangers = scopedEmployeeIds.filter((id) => !roster.has(id));
      if (strangers.length > 0) {
        throw new PayrollError(
          `${strangers.length} named employee(s) are not on this pay schedule`,
        );
      }
    }

    const seq = (await tx.execute(sql`
      insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
      values (${orgId}, 'pay_run', null, 'PAY-')
      on conflict on constraint sequences_org_kind_sub
      do update set next_number = number_sequences.next_number + 1
      returning prefix, next_number, padding
    `)) as unknown as { rows: { prefix: string; next_number: number; padding: number }[] };
    const number = `${seq.rows[0]!.prefix}${String(seq.rows[0]!.next_number).padStart(seq.rows[0]!.padding, "0")}`;

    const doc = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, subsidiary_id, document_date,
                             currency, status, memo, created_by, updated_by)
      values (${orgId}, 'pay_run', ${number}, ${runContext.subsidiaryId}, ${payDate},
              ${runContext.currency}, 'draft',
              ${`${RUN_TYPE_MEMO[runType]} ${periodStart} – ${periodEnd}`}, ${actorId}, ${actorId})
      returning id
    `)) as unknown as { rows: { id: string }[] };
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
    if (runType === "termination") {
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

interface YtdRow {
  pensionable: string; insurable: string; cpp: string; cpp2: string; ei: string;
  qpip: string; non_periodic: string; f5b: string; qc_csb: string;
}

async function employeeYtd(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string,
  taxYear: number, excludeDocumentId: string,
): Promise<YtdRow> {
  const r = (await tx.execute(sql`
    select
      coalesce((select pensionable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.pensionable_earnings), 0) as pensionable,
      coalesce((select insurable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.insurable_earnings), 0) as insurable,
      coalesce((select cpp_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'C')::numeric), 0) as cpp,
      coalesce((select cpp2_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'C2')::numeric), 0) as cpp2,
      coalesce((select ei_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'EI')::numeric), 0) as ei,
      coalesce((select qpip_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'QPIP')::numeric), 0) as qpip,
      coalesce((select non_periodic_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'B')::numeric), 0) as non_periodic,
      coalesce(sum((s.factors->>'F5B')::numeric), 0) as f5b,
      coalesce(sum((s.factors->>'QC_CSB')::numeric), 0) as qc_csb
    from pay_stubs s
    join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
    where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
      and s.tax_year = ${taxYear} and s.pay_run_document_id <> ${excludeDocumentId}
  `)) as unknown as { rows: YtdRow[] };
  return r.rows[0]!;
}

interface UsYtdRow {
  fica: string;
  futa: string;
  supplemental: string;
}

/**
 * US YTD state for the wage-base caps: the caps compare cumulative WAGES
 * (not contributions) against the base, so the generic pensionable/insurable
 * stub columns — FICA and FUTA/SUI wages for US employees — plus the same
 * opening-balance columns are the whole story.
 */
async function usEmployeeYtd(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string,
  taxYear: number, excludeDocumentId: string,
): Promise<UsYtdRow> {
  const r = (await tx.execute(sql`
    select
      coalesce((select pensionable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.pensionable_earnings), 0) as fica,
      coalesce((select insurable_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum(s.insurable_earnings), 0) as futa,
      coalesce((select non_periodic_ytd from payroll_opening_balances
                 where org_id = ${orgId} and employee_party_id = ${employeePartyId} and tax_year = ${taxYear}), 0)
      + coalesce(sum((s.factors->>'B')::numeric), 0) as supplemental
    from pay_stubs s
    join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
    where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
      and s.tax_year = ${taxYear} and s.pay_run_document_id <> ${excludeDocumentId}
  `)) as unknown as { rows: UsYtdRow[] };
  return r.rows[0]!;
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
async function resolvePayRate(
  tx: Pick<typeof db, "execute">, orgId: string, employeePartyId: string, onDate: string,
  /** Functional currency of the run (the run document's currency). */
  payCurrency: string | null,
): Promise<{ basis: "hour" | "year"; rate: string; annualHours: string; currency: string } | null> {
  const r = (await tx.execute(sql`
    select * from ${effectivePayRateSql({
      org: sql`${orgId}`,
      employee: sql`${employeePartyId}`,
      onDate: sql`${onDate}`,
      selectList: sql`w.basis, w.rate, w.annual_hours, w.currency`,
    })} as rate
  `)) as unknown as {
    rows: { basis: "hour" | "year"; rate: string; annual_hours: string; currency: string }[];
  };
  const row = r.rows[0];
  if (!row) return null;
  const resolved = {
    basis: row.basis, rate: row.rate, annualHours: row.annual_hours, currency: row.currency,
  };
  if (!payCurrency || !row.currency || row.currency === payCurrency) return resolved;

  const { convertLaborWage, laborFxRate } = await import("./labor-costing.ts");
  const fxRate = await laborFxRate(orgId, row.currency, payCurrency, onDate);
  if (!fxRate) {
    throw new PayrollError(
      `no spot rate for the wage ${row.currency}→${payCurrency} on or before ${onDate}`
      + " — enter one before this employee can be paid",
    );
  }
  return { ...resolved, rate: convertLaborWage(row.rate, fxRate), currency: payCurrency };
}

export interface PayRunCalculation {
  employees: number;
  errors: { employee: string; message: string }[];
  gross: string;
  net: string;
  employerCost: string;
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
   * Compute and total the run without persisting anything — the operator sees
   * exactly what a real calculation would produce (including per-employee
   * errors) and the run stays in whatever state it was in.
   */
  dryRun?: boolean;
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
    const runRows = (await tx.execute(sql`
      select r.*, d.status as doc_status, d.currency as doc_currency,
             d.subsidiary_id as doc_subsidiary_id,
             sub.name as subsidiary_name, sub.country as subsidiary_country,
             sub.base_currency as subsidiary_currency
        from pay_runs r
        join documents d on d.id = r.document_id
        left join subsidiaries sub on sub.id = d.subsidiary_id and sub.org_id = d.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       -- Lock the run and its document only. The subsidiary is read-only
       -- jurisdiction context on the nullable side of an outer join, and
       -- Postgres refuses FOR UPDATE there.
       for update of r, d
    `)) as unknown as { rows: Record<string, string>[] };
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (run.run_status === "committed") throw new PayrollError("pay run is already committed");
    if (run.doc_status !== "draft") throw new PayrollError("pay run document is not editable");

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
    const statHolidayPay = await statutoryHolidayPayEnabled(orgId, tx);
    if (statHolidayPay) await ensureStatutoryHolidayComponents(tx, orgId, actorId);

    const components = (await tx.execute(sql`
      select * from pay_components where org_id = ${orgId} and is_active order by sequence
    `)) as unknown as { rows: Record<string, unknown>[] };
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
    const scheduleScope = (await tx.execute(sql`
      select subsidiary_id from pay_schedules where org_id = ${orgId} and id = ${run.pay_schedule_id}
    `)) as unknown as { rows: { subsidiary_id: string | null }[] };
    const scopedSubsidiaryId = scheduleScope.rows[0]?.subsidiary_id ?? null;
    const runType = (run.run_type as string) ?? "regular";
    // `distinct on (p.id)` is load-bearing, not tidiness: employee_roles is
    // joined per party and a second role row would run calculateStub twice for
    // one person — a duplicate stub, doubled pay, and (because the EHT and WCB
    // accumulators below read this run's own stubs) a doubly-consumed
    // exemption. One employee, one pass, stated in the query.
    const employees = (await tx.execute(sql`
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
         order by p.id, er.terminated_on nulls last
      ) roster
      order by roster.display_name
    `)) as unknown as { rows: Record<string, string | null>[] };

    await tx.execute(sql`delete from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}`);
    // Movements are deleted with the stubs that produced them, on the same
    // key, so an employee who has dropped OFF the run (excluded, terminated,
    // moved schedule) leaves no orphaned bank movement behind. Per-employee
    // replacement inside calculateStub cannot see someone who is no longer
    // being calculated. See .local/payroll-pipeline-contract.md, "Ledger
    // writes".
    await tx.execute(sql`
      delete from entitlement_ledger
       where org_id = ${orgId} and pay_run_document_id = ${documentId}`);

    // Run-level input adjustments: exclusions drop the employee entirely;
    // 'line' rows are merged into the stub's inputs inside calculateStub.
    const excludedRows = (await tx.execute(sql`
      select employee_party_id from pay_run_adjustments
       where org_id = ${orgId} and pay_run_document_id = ${documentId}
         and adjustment_type = 'exclude'
    `)) as unknown as { rows: { employee_party_id: string }[] };
    const excluded = new Set(excludedRows.rows.map((r) => r.employee_party_id));

    const usConfig = await usPayrollConfig(orgId);
    const caConfig = await caPayrollConfig(orgId);
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
            country: emp.country,
            region: emp.province,
            subsidiaryId: emp.employee_subsidiary_id ?? null,
            subsidiaryCountry: emp.employee_subsidiary_country ?? null,
            filingAccountId: emp.effective_filing_account_id ?? null,
            filingAccountCountry: emp.filing_account_country ?? null,
            filingAccountNumber: emp.filing_account_number ?? null,
          },
        });
        const result = await calculateStub(tx, {
          orgId, actorId, documentId, run, emp, runContext, jurisdiction,
          periodsPerYear: P, need, components: components.rows, usConfig, caConfig,
          eftFallbackToCheque, statHolidayPay,
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
    // it wrote so the operator's preview costs the run nothing.
    if (input.dryRun) throw new DryRunRollback(result);

    await tx.execute(sql`
      update pay_runs set run_status = 'calculated', calculated_at = now(),
             gross_total = ${grossTotal}, net_total = ${netTotal},
             employer_cost_total = ${employerTotal}, employee_count = ${count},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
    return result;
  });
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
    need: (systemKey: string, kind: string) => Record<string, unknown>;
    components: Record<string, unknown>[];
    usConfig: UsPayrollConfig;
    caConfig: CaPayrollConfig;
    /** orgs.settings.payroll.eftFallbackToCheque, read once for the run. */
    eftFallbackToCheque: boolean;
    /** orgs.settings.payroll.statutoryHolidayPay, read once for the run. */
    statHolidayPay: boolean;
  },
): Promise<StubComputation> {
  const { orgId, actorId, documentId, run, emp, jurisdiction } = ctx;
  const employeePartyId = emp.party_id!;
  const schedule = (await tx.execute(sql`
    select periods_per_year from pay_schedules where id = ${run.pay_schedule_id}
  `)) as unknown as { rows: { periods_per_year: number }[] };
  const P = schedule.rows[0]!.periods_per_year;
  // Every one of these comes from the resolved context, not from re-reading
  // `emp` and defaulting. `country` decides which statutory engine runs;
  // `region` is the province or state it runs for; both were asserted against
  // the paying legal entity before this function was called.
  const { country, region: province } = jurisdiction;
  const taxYear = jurisdiction.taxYear;

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
  const lines: Line[] = [];
  // Entitlement movements are written to the ledger only after the stub rows
  // exist, so they can carry the stub_line_id that produced them.
  const entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"] = [];
  const entitlementWarnings: EntitlementWarning[] = [];

  const payRate = await resolvePayRate(
    tx, orgId, employeePartyId, run.period_end, run.doc_currency ?? null,
  );
  const baseComponent = ctx.need("base_pay", "earning");

  // An off-cycle bonus run pays only its one-off lines: no salary, no time,
  // and no recurring components (a bonus cheque does not re-take the period's
  // benefit deductions). Its earnings are taxed on the T4127 bonus method.
  const runType = (run.run_type as string) ?? "regular";
  const bonusRun = runType === "bonus";

  // Is the effective rate row one the run can actually pay on? The rule lives
  // in engine/src/payroll-rate.ts and readiness asks it in SQL, so the
  // pre-flight and the run cannot disagree — which they did, before the
  // predicate had one owner: a salaried employee holding only an hourly rate
  // passed readiness green and then threw here.
  if (!bonusRun && !payRateIsUsable(emp.pay_basis, payRate)) {
    throw new PayrollError(payRate
      ? "salaried employee has no annual labor cost rate (employee scope)"
      : "no labor cost rate covers this employee for the period");
  }

  if (bonusRun) {
    // no periodic earnings — adjustments below carry the bonus
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
    const time = (await tx.execute(sql`
      select te.id, te.hours, te.project_id, te.department_id, te.time_type_id,
             coalesce(tt.classification, 'regular') as classification,
             coalesce(tt.cost_multiplier, 1) as multiplier, coalesce(tt.name, 'Regular') as type_name
        from time_entries te
        left join time_types tt on tt.id = te.time_type_id
       where te.org_id = ${orgId} and te.employee_party_id = ${employeePartyId}
         and te.status = 'approved'
         and te.worked_on between ${run.period_start} and ${run.period_end}
         and (te.payroll_batch_ref is null or te.payroll_batch_ref = ${documentId})
         and coalesce(tt.exclude_from_wages, false) = false
    `)) as unknown as {
      rows: {
        id: string; hours: string; project_id: string | null; department_id: string | null;
        time_type_id: string | null; classification: string; multiplier: string; type_name: string;
      }[];
    };
    const otComponent = ctx.need("overtime", "earning");
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

  // Recurring assigned components (allowances, RRSP match, dues, garnishees…).
  // Country-scoped components only apply to that country's employees; rows
  // with no country are shared across packs. `country` is the RESOLVED one
  // (see the destructure at the top of this function) — it used to be
  // re-derived right here as `emp.country === "US" ? "US" : "CA"`.
  const assigned = (await tx.execute(sql`
    select a.value as override, c.*
      from employee_pay_components a
      join pay_components c on c.id = a.component_id
     where a.org_id = ${orgId} and a.employee_party_id = ${employeePartyId}
       and a.is_active and c.is_active and c.system_key is null
       and (c.country is null or c.country = ${country})
       and a.effective_from <= ${run.period_end}
       and (a.effective_to is null or a.effective_to >= ${run.period_end})
     order by c.sequence
  `)) as unknown as { rows: Record<string, unknown>[] };

  const earningsBase = () =>
    sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly).map((l) => l.amount));
  const totalHours = () =>
    sum(lines.filter((l) => l.hours).map((l) => l.hours!));

  /**
   * The current earnings collapsed to one bucket per project/department — the
   * weights any job-costed employer burden allocates against. The untagged
   * bucket is deliberately included so an overhead share stays overhead
   * instead of being pushed onto whichever jobs happen to be on the stub.
   */
  const earningJobBuckets = (): {
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

  // Phase 2 — derived earnings. Per diem for nights stayed, on-call days,
  // travel pay costed to the first job of the day, site and equipment
  // incentives: money produced by operational facts rather than typed in and
  // hand-corrected. Rules emit INPUTS, exactly like time and adjustments, so
  // the statutory pass still owns every computed output.
  //
  // Off-cycle bonus runs are skipped: they pay only their one-off lines, and a
  // month_end rule landing inside an already-paid period would settle twice.
  if (!bonusRun) {
    const derivedRules = await loadActiveDerivedRules(tx, orgId, run.period_end);
    if (derivedRules.length > 0) {
      // Salaried supervisors earn derived amounts too, and the hourly branch's
      // time query is scoped to wages, so read the period's facts explicitly.
      const facts = (await tx.execute(sql`
        select te.id, te.worked_on, te.hours, te.time_type_id, te.project_id,
               te.department_id, te.is_billable, te.created_at
          from time_entries te
         where te.org_id = ${orgId} and te.employee_party_id = ${employeePartyId}
           and te.status = 'approved'
           and te.worked_on between ${run.period_start} and ${run.period_end}
           and (te.payroll_batch_ref is null or te.payroll_batch_ref = ${documentId})
      `)) as unknown as {
        rows: {
          id: string; worked_on: string; hours: string; time_type_id: string | null;
          project_id: string | null; department_id: string | null;
          is_billable: boolean; created_at: string | Date;
        }[];
      };
      const derived = await resolveDerivedEarnings(tx, {
        orgId,
        employeePartyId,
        periodStart: run.period_start,
        periodEnd: run.period_end,
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
        gross: earningsBase(),
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

  // Phase 2 — statutory holiday pay. A day's pay derived from a LOOKBACK over
  // prior earnings, plus the premium for hours actually worked on the day,
  // where — and only where — the jurisdiction declares one. The formula is a
  // statutory fact declared per jurisdiction in the country pack
  // (engine/src/payroll/packs.ts), never hardcoded here: Ontario divides four
  // weeks of regular wages plus vacation pay by 20, British Columbia divides
  // thirty days of wages by the days actually worked, Saskatchewan takes five
  // per cent. Landing here, before phase 3, is what puts the day's pay in
  // gross for percent-of-gross components, vacation, union fringes, WCB and
  // the statutory pass (.local/payroll-pipeline-contract.md).
  //
  // Gated on orgs.settings.payroll.statutoryHolidayPay (OFF for existing
  // tenants: the phase changes gross, so it is opted into, never inherited by
  // upgrade). Skipped on an off-cycle bonus run, which pays only its one-off
  // lines.
  //
  // A jurisdiction NO pack has transcribed (CA-MB, US-MA) is neither guessed
  // at nor blindly refused: with no statutory holiday in the period it
  // calculates exactly as it always has, and when one lands in the period —
  // probed against the country's declared employment calendars — the run stops
  // with the same message readiness raises, naming the jurisdiction and the
  // holiday. A silent zero on a paid holiday is indistinguishable from a
  // correct calculation, which is why the refusal exists.
  if (!bonusRun && ctx.statHolidayPay) {
    const employeeJurisdiction = jurisdictionKey(country, province);
    if (!payrollJurisdictionDeclared(employeeJurisdiction)) {
      const conflict = undeclaredJurisdictionHolidayConflict({
        country, jurisdiction: employeeJurisdiction,
        from: run.period_start, to: run.period_end,
      });
      if (conflict) throw new PayrollError(conflict.message);
    } else {
      const holidayRate = payRate
        ? (payRate.basis === "hour"
            ? payRate.rate
            : divideMoney(payRate.rate, payRate.annualHours, 4))
        : "0";
      const holidayLines = await resolveStatutoryHolidayPay(tx, {
        orgId,
        employeePartyId,
        employeeName: emp.display_name ?? employeePartyId,
        jurisdiction: employeeJurisdiction,
        periodStart: run.period_start,
        periodEnd: run.period_end,
        holidayComponentId: ctx.need("stat_holiday", "earning").id as string,
        premiumComponentId: ctx.need("stat_holiday_premium", "earning").id as string,
        excludeDocumentId: documentId,
        hourlyRate: holidayRate,
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

  /** Same component's committed amount earlier in the tax year (openings
   *  included via the opening-balance sweep the year-end module owns). Mid-year
   *  adoption must not hand an employee a fresh 402(g)/money-purchase room. */
  const componentYearToDate = async (componentId: string): Promise<string> => {
    const r = (await tx.execute(sql`
      select coalesce(sum(l.amount), 0)::text as ytd
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id
        join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
       where l.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
         and s.tax_year = ${taxYear} and l.component_id = ${componentId}
         and s.pay_run_document_id <> ${documentId}
    `)) as unknown as { rows: { ytd: string }[] };
    return r.rows[0]!.ytd;
  };

  // Hours behind a capped basis. "Overtime or double time charged to a job is
  // exempt from the 40-hour cap" is a property of the hour, not of the
  // component, so the predicate lives here and the engine stays pure.
  const cappableHourLines = () =>
    lines
      .filter((l) => l.kind === "earning" && l.hours && !l.accrualOnly)
      .map((l) => ({
        hours: l.hours!,
        amount: l.amount,
        exemptFromHoursCap:
          (l.classification === "overtime" || l.classification === "double_time")
          && l.projectId != null,
      }));

  for (const c of bonusRun ? [] : assigned.rows) {
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
          lines: cappableHourLines(),
          yearToDate: capped.basisCapAmountPerYear != null
            ? await componentYearToDate(c.id as string)
            : "0",
        }
      : {};
    let amount: string;
    if (c.basis === "per_hour") {
      amount = roundMoney(mulDecimal(value, applyBasisCaps(capped, totalHours(), context)), 2);
    } else if (c.basis === "percent_of_gross") {
      amount = mulPercent(applyBasisCaps(capped, earningsBase(), context), value, 2);
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

  // Run-level 'line' adjustments — one-off inputs for THIS employee in THIS
  // run. replaceComponent swaps out the component's derived lines (time,
  // salary, or recurring) before the one-off amount lands; either way the
  // statutory math below sees the adjusted inputs, never edited outputs.
  const adjustments = (await tx.execute(sql`
    select a.amount as adj_amount, a.hours as adj_hours, a.replace_component, a.note, c.*
      from pay_run_adjustments a
      join pay_components c on c.id = a.component_id
     where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
       and a.employee_party_id = ${employeePartyId} and a.adjustment_type = 'line'
     order by c.sequence, a.created_at
  `)) as unknown as { rows: Record<string, unknown>[] };
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
      // would over-withhold badly.
      nonPeriodic: bonusRun ? adj.kind === "earning" : (adj.non_periodic as boolean),
      taxTreatment: adj.tax_treatment as string,
      // A one-off garnishment entered for a single run is still a protected
      // deduction, and still belongs to (or outside) the protected base.
      protectionBase: adj.protection_base as string,
      protectionMaxPercent: adj.protection_max_percent as string | null,
      protectionPriority: Number(adj.protection_priority ?? 100),
      includeInDisposableEarnings: adj.include_in_disposable_earnings as boolean,
    });
  }

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
        const hours = totalHours();
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
        const amount = mulPercent(earningsBase(), fringe.value, 2);
        if (cmp(amount, "0") === 0) continue;
        // Percent-of-gross splits proportional to the earnings it is a percent
        // OF — including the untagged share, which stays untagged rather than
        // being pushed onto the jobs.
        const buckets = jobCosted ? earningJobBuckets() : [];
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

  // Phases 6 and 7 — vacation pay plus every other entitlement plan (banked
  // time, sick banks, benefit recoup) through ONE engine; see
  // engine/src/payroll-entitlements.ts.
  //
  // The employee's vacation_percent stays on the payroll profile, its one
  // home; it is handed to the Vacation plan as that employee's rate. A reached
  // service tier (5 years → 6%) overrides it. `pay_each_period` and a final pay
  // still settle in cash rather than banking, so the accrue-vs-pay decision is
  // unchanged from the operator's point of view.
  const vacationPercent = emp.vacation_percent;
  let vacationAccrued = "0";
  const terminationRun = runType === "termination";
  const plans = await entitlementPlans(orgId, tx);
  // Resolved on the plan's ENGINE BINDING, never on its operator-typed code.
  const vacationPlan = vacationPlanOf(plans);
  assertVacationPlanResolved(emp, vacationPlan, terminationRun);

  // A final pay must clear every accrued bank: the carried balance is paid out
  // with this period's accrual, never left on the books for someone who left.
  //
  // The balances are read INSIDE this transaction and NET OF THIS RUN'S OWN
  // movements. Both matter: without the exclusion the second Calculate saw the
  // first Calculate's `−balance` payout row, netted to zero, and silently
  // dropped the departing employee's entire accrued balance from their final
  // cheque — leaving the liability on the books with nobody to pay it to.
  if (terminationRun && plans.length > 0) {
    const balances = await entitlementBalances(orgId, employeePartyId, run.pay_date, {
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
        planId: balance.plan.id, employeePartyId, movementDate: run.pay_date,
        amount: neg(roundMoney(balance.balance, 2)), hours: null,
        kind: "payout", componentId: balance.plan.payoutComponentId,
        note: "Final pay — bank cleared",
      });
    }
  }

  // Cash-out vacation policies bypass the bank entirely: the money is paid,
  // not accrued, so no ledger movement is produced.
  const payVacationInCash = emp.vacation_method === "pay_each_period" || terminationRun;
  if (payVacationInCash && vacationPercent && cmp(vacationPercent, "0") > 0) {
    const base = sum(lines
      .filter((l) => l.kind === "earning" && (l.vacationable ?? true) && !l.accrualOnly)
      .map((l) => l.amount));
    const vacation = mulPercent(base, vacationPercent, 2);
    if (cmp(vacation, "0") > 0) {
      const c = ctx.need("vacation_payout", "earning");
      lines.push({
        componentId: c.id as string, kind: "earning", description: "Vacation pay",
        amount: vacation, sequence: 45, vacationable: false,
      });
    }
  }

  // Everything that banks: one call, honouring scoped caps and service tiers.
  if (plans.length > 0) {
    const bankablePlans = payVacationInCash && vacationPlan
      ? plans.filter((p) => p.id !== vacationPlan.id)
      : plans;
    const { movements, warnings } = await planMovementsForStub(tx, {
      orgId, employeePartyId, movementDate: run.pay_date,
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
  interface StatutoryAllocation {
    amount: string;
    projectId?: string | null;
    departmentId?: string | null;
  }
  /** Earnings-assessed slots already emitted on this stub, `systemKey:kind`. */
  const emittedEarningsAssessed = new Set<string>();

  const pushStatutory = (
    systemKey: string, kind: "deduction" | "employer_contribution",
    description: string, amount: string, sequence: number,
    options: {
      /**
       * Job-costed levies (WCB) emit their whole allocation in ONE call, so
       * the idempotency guard covers the split as a unit and a re-run can
       * never re-allocate the remainder.
       */
      allocations?: readonly StatutoryAllocation[];
    } = {},
  ) => {
    if (cmp(amount, "0") === 0) return;
    const assessedOn = statutoryAssessment(country, systemKey, kind);
    const slot = `${systemKey}:${kind}`;
    // Recomputing the value on a later pass is harmless (the statutory engines
    // return CPP/EI/tax from one call); re-PUSHING it is not.
    if (assessedOn === "earnings" && emittedEarningsAssessed.has(slot)) return;
    const c = ctx.need(systemKey, kind);
    let pushed = false;
    for (const allocation of options.allocations ?? [{ amount }]) {
      if (cmp(allocation.amount, "0") === 0) continue;
      lines.push({
        componentId: c.id as string, kind, description,
        amount: allocation.amount, sequence,
        projectId: allocation.projectId ?? null,
        departmentId: allocation.departmentId ?? null,
        assessedOn,
      });
      pushed = true;
    }
    // Only a line that actually landed marks the slot emitted: a slot that was
    // zero on the first pass and non-zero on a later one is a violation the
    // assertion below must SEE, not something this guard should hide.
    if (assessedOn === "earnings" && pushed) emittedEarningsAssessed.add(slot);
  };

  /** Every earnings-assessed line as the invariant check compares them. */
  const earningsAssessedSnapshot = (): EarningsAssessedLine[] =>
    lines
      .filter((l) => l.assessedOn === "earnings")
      .map((l) => ({
        component: l.description,
        amount: l.amount,
        projectId: l.projectId ?? null,
        departmentId: l.departmentId ?? null,
      }));

  // ---- Employer taxes: WCB/WSIB and Ontario EHT (CA pack) ------------------
  // Both are employer-only accruals. WCB assesses gross earnings (capped at
  // the class's annual assessable max) at the worker-comp group's rate and is
  // job-costed by project like the earnings it assesses. EHT is org-level:
  // Ontario remuneration past the annual exemption at the configured rate,
  // consuming the exemption across all employees in pay-date order.
  //
  // BOTH accumulators consume against CALCULATED-OR-COMMITTED stubs, not
  // committed ones alone. A finite annual allowance — the WCB assessable
  // ceiling, the Ontario EHT exemption — that is only consumed on commit is
  // claimed IN FULL by every schedule calculated before the first of them
  // commits, so two schedules calculated the same afternoon each spend the
  // whole exemption and the employer under-remits.
  //
  // Two dependencies this makes explicit rather than assuming:
  //   1. the stubs of THIS run are visible to these reads because they are
  //      inserted by the same transaction, one employee at a time, in
  //      calculateStub — which is why the run's own document id is still
  //      OR-ed in (run_status is not flipped to 'calculated' until the end);
  //   2. exactly ONE stub per employee per run exists, which the roster query
  //      in calculateInTransaction guarantees with `distinct on (p.id)` and
  //      the `delete from pay_stubs` that precedes the loop. A second pass
  //      over one employee would consume the exemption twice.
  let wcbAmount = "0";
  let wcbAssessable = "0";
  let ehtAmount = "0";
  let ehtEarnings = "0";
  if (country === "CA") {
    const grossEarnings = () =>
      sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly).map((l) => l.amount));
    const wcbGroup = (await tx.execute(sql`
      select g.rate_percent, g.max_assessable
        from employee_roles er
        join worker_comp_groups g on g.id = er.worker_comp_group_id and g.is_active
       where er.org_id = ${orgId} and er.party_id = ${employeePartyId} and er.is_active
       limit 1
    `)) as unknown as { rows: { rate_percent: string | null; max_assessable: string | null }[] };
    const wcb = wcbGroup.rows[0];
    if (wcb?.rate_percent && cmp(wcb.rate_percent, "0") > 0) {
      const priorAssessable = ((await tx.execute(sql`
        select coalesce(sum((s.factors->>'WCB_EARN')::numeric), 0) as prior
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id
         where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
           and s.tax_year = ${taxYear}
           and (r.run_status in ('calculated', 'committed')
                or s.pay_run_document_id = ${documentId})
      `)) as unknown as { rows: { prior: string }[] }).rows[0]!.prior;
      const gross = grossEarnings();
      const room = wcb.max_assessable
        ? (cmp(wcb.max_assessable, priorAssessable) > 0 ? add(wcb.max_assessable, neg(priorAssessable)) : "0")
        : gross;
      wcbAssessable = cmp(gross, room) <= 0 ? gross : room;
      if (cmp(wcbAssessable, "0") > 0) {
        wcbAmount = mulPercent(wcbAssessable, wcb.rate_percent, 2);
        // Split by project proportional to earning amounts (WCB is a real
        // job-cost burden, like union fringes). Exact bigint ratios; the last
        // job absorbs the rounding remainder so the premium never leaks a
        // penny. The whole allocation is handed to pushStatutory in one call,
        // so a second protection pass cannot allocate that remainder again.
        //
        // The remainder is signed and is absorbed WHATEVER its sign. Rounding
        // each share independently can over-allocate as easily as under: gross
        // 1,000.00 split 333.33 / 333.33 / 333.33 with 0.01 untagged, at 5%,
        // allocates 50.01 against a 50.00 premium. Dropping the negative
        // remainder silently — as a `> 0` guard does — leaves the stub lines
        // and factors.WCB permanently disagreeing, and the remittance summary
        // (which sums pay_stub_lines) permanently at odds with the annual-cap
        // tracker (which reads factors.WCB_EARN).
        const splits = lines.filter((l) => l.kind === "earning" && !l.accrualOnly && l.projectId);
        const grossUnits = toUnits(gross);
        const allocations: StatutoryAllocation[] = [];
        let allocated = "0";
        const allTagged = cmp(sum(splits.map((s) => s.amount)), gross) === 0;
        for (const [index, split] of splits.entries()) {
          const share = index === splits.length - 1 && allTagged
            ? add(wcbAmount, neg(allocated))
            : roundMoney(mulRatio(wcbAmount, toUnits(split.amount), grossUnits), 2);
          if (cmp(share, "0") === 0) continue;
          allocated = add(allocated, share);
          allocations.push({
            amount: share, projectId: split.projectId, departmentId: split.departmentId,
          });
        }
        const remainder = add(wcbAmount, neg(allocated));
        if (cmp(remainder, "0") !== 0) {
          // A negative remainder belongs to the job that was rounded up, not
          // to the untagged pool, so it lands on the last allocated line;
          // a positive one is genuinely unallocated overhead.
          const last = allocations[allocations.length - 1];
          if (cmp(remainder, "0") < 0 && last) last.amount = add(last.amount, remainder);
          else allocations.push({ amount: remainder });
        }
        const allocatedTotal = sum(allocations.map((a) => a.amount));
        if (cmp(allocatedTotal, wcbAmount) !== 0) {
          throw new PayrollError(
            `WCB allocation ${allocatedTotal} does not equal the ${wcbAmount} premium `
            + `for ${emp.display_name ?? employeePartyId}`,
          );
        }
        pushStatutory("wcb", "employer_contribution", "WCB/WSIB", wcbAmount, 260, { allocations });
      }
    }

    const eht = ctx.caConfig.eht;
    // Already inside `country === "CA"`, and `province` is the resolved
    // region — the old `(emp.country ?? "CA") !== "US"` re-derivation was a
    // third opinion on a question the run context now answers once.
    if (eht.enabled && eht.rate && province === "ON") {
      ehtEarnings = grossEarnings();
      if (cmp(ehtEarnings, "0") > 0) {
        const priorOn = ((await tx.execute(sql`
          select coalesce(sum((s.factors->>'EHT_EARN')::numeric), 0) as prior
            from pay_stubs s
            join pay_runs r on r.document_id = s.pay_run_document_id
           where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.province = 'ON'
             and (r.run_status in ('calculated', 'committed')
                  or s.pay_run_document_id = ${documentId})
        `)) as unknown as { rows: { prior: string }[] }).rows[0]!.prior;
        const exemption = eht.annualExemption ?? "0";
        const exemptionLeft = cmp(exemption, priorOn) > 0 ? add(exemption, neg(priorOn)) : "0";
        const taxableRemuneration = cmp(ehtEarnings, exemptionLeft) > 0
          ? add(ehtEarnings, neg(exemptionLeft))
          : "0";
        if (cmp(taxableRemuneration, "0") > 0) {
          ehtAmount = mulPercent(taxableRemuneration, eht.rate, 2);
          pushStatutory("eht", "employer_contribution", "Employer Health Tax", ehtAmount, 270);
        }
      }
    }
  }

  // Statutory inputs from the line set. For US employees the flags
  // generalize: taxable → FIT wages, pensionable → FICA (Social Security /
  // Medicare) wages, insurable → FUTA and SUI wages.
  const earning = (predicate: (l: Line) => boolean) =>
    sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly && predicate(l)).map((l) => l.amount));
  const deduction = (treatment: string) =>
    sum(lines.filter((l) => l.kind === "deduction" && l.taxTreatment === treatment).map((l) => l.amount));

  const gross = earning(() => true);
  const income = earning((l) => (l.taxable ?? true) && !(l.nonPeriodic ?? false));
  const nonPeriodic = earning((l) => (l.taxable ?? true) && (l.nonPeriodic ?? false));
  const pensionable = earning((l) => l.pensionable ?? true);
  const insurable = earning((l) => l.insurable ?? true);

  /**
   * Drop the previous pass's INCOME-assessed withholdings so the pass can be
   * re-derived from a changed pre-tax deduction. Earnings-assessed lines are
   * left standing — no deduction moves them, and re-pushing one would double a
   * levy and re-run its project split.
   */
  const clearIncomeAssessedLines = () => dropIncomeAssessedLines(lines);

  const bool = (value: string | null | undefined) =>
    value === "true" || (value as unknown) === true;
  // `province` is the resolved region. It used to default to "ON" for a
  // Canadian employee whose profile carried no province — silently withholding
  // Ontario provincial tax on someone whose jurisdiction nobody had recorded.
  let factors: Record<string, string> = {};
  let firstEarningsAssessed: EarningsAssessedLine[] | null = null;

  /**
   * One statutory pass over the CURRENT line set. `income`, `nonPeriodic`,
   * `pensionable` and `insurable` are earnings-only and therefore stable
   * across passes; what changes between passes is `deduction("pension_f")` /
   * `deduction("alimony")` / `deduction("union_dues")`, which is exactly why a
   * pre-tax protected order has to be settled by iteration.
   *
   * The pass re-COMPUTES everything each time — the CRA and IRS engines return
   * CPP/EI/QPIP/FICA and tax from a single call, and splitting them would fork
   * a conformance-tested engine for no gain — but `pushStatutory` re-emits only
   * the income-assessed lines. Earnings-assessed ones stand from the first
   * pass, and `assertEarningsAssessedStable` proves afterwards that standing
   * still was the right answer.
   */
  const runStatutoryPass = async (): Promise<void> => {
    clearIncomeAssessedLines();
    if (country === "US") {
    // The unsupported-region refusal is the country pack's answer now, not two
    // inline US-only checks (engine/src/payroll/packs.ts). Same behaviour for
    // the US; the CA arm below finally gets the same question asked of it,
    // which is how Quebec stopped being silently half-withheld.
    assertPayrollRegionSupported(country, province);
    const ytd = await usEmployeeYtd(tx, orgId, employeePartyId, taxYear, documentId);
    const filingStatus = (emp.filing_status ?? "single") as "single" | "married_joint" | "head_household";
    const statutory = calculatePub15T({
      payDate: run.pay_date, periodsPerYear: P,
      wages: income, supplemental: nonPeriodic,
      ficaWages: pensionable, futaWages: insurable,
      filingStatus,
      multipleJobs: bool(emp.multiple_jobs),
      dependentCredits: emp.dependent_credits ?? undefined,
      otherIncomeAnnual: emp.other_income_annual ?? undefined,
      deductionsAnnual: emp.deductions_annual ?? undefined,
      extraPerPeriod: emp.additional_tax_per_period ?? undefined,
      pre2020: bool(emp.w4_pre_2020)
        ? { allowances: Number(emp.w4_allowances ?? 0), married: filingStatus === "married_joint" }
        : undefined,
      fitExempt: bool(emp.tax_exempt),
      ficaExempt: bool(emp.fica_exempt),
      futaExempt: bool(emp.futa_exempt),
      futaEffectiveRate: ctx.usConfig.futaRate ?? undefined,
      sui: ctx.usConfig.sui[province],
      ytd: {
        ssWages: ytd.fica, medicareWages: ytd.fica,
        futaWages: ytd.futa, suiWages: ytd.futa,
        supplemental: ytd.supplemental,
      },
    });
    pushStatutory("fit", "deduction", "Federal income tax", statutory.fit, 110);
    pushStatutory("ss", "deduction", "Social Security", statutory.ss, 120);
    pushStatutory("medicare", "deduction", "Medicare", statutory.medicare, 130);
    pushStatutory("medicare_addl", "deduction", "Additional Medicare", statutory.additionalMedicare, 135);
    pushStatutory("ss", "employer_contribution", "Social Security (employer)", statutory.ssEmployer, 210);
    pushStatutory("medicare", "employer_contribution", "Medicare (employer)", statutory.medicareEmployer, 220);
    pushStatutory("futa", "employer_contribution", "Federal unemployment (FUTA)", statutory.futa, 230);
    pushStatutory("suta", "employer_contribution", "State unemployment (SUI)", statutory.suta, 250);
    factors = {
      ...statutory.factors,
      B: nonPeriodic, I: income, PI: pensionable, IE: insurable,
    };
  } else {
    // The CA arm, asked the same question the US arm has always been asked.
    // Every province is supported now that the QC engine exists: T4127
    // computes the federal side (abatement, QPP, QPIP) for Quebec and
    // engine/src/payroll/canada/quebec computes TP-1015 provincial income
    // tax below. The assertion still refuses an unknown province by name.
    assertPayrollRegionSupported(country, province);

    const ytd = await employeeYtd(tx, orgId, employeePartyId, taxYear, documentId);

    const t4127Input: T4127Input = {
      payDate: run.pay_date, province: province as Province, periodsPerYear: P,
      income, nonPeriodic, pensionable, insurable,
      pensionDeductions: deduction("pension_f"),
      alimonyDeductions: deduction("alimony"),
      unionDues: deduction("union_dues"),
      prescribedZoneDeduction: emp.prescribed_zone_deduction ?? undefined,
      authorizedAnnualDeductions: emp.authorized_annual_deductions ?? undefined,
      authorizedFederalCredits: emp.authorized_federal_credits ?? undefined,
      authorizedProvincialCredits: emp.authorized_provincial_credits ?? undefined,
      additionalTaxPerPeriod: emp.additional_tax_per_period ?? undefined,
      federalClaim: emp.federal_claim_amount ?? undefined,
      federalClaimCode: emp.federal_claim_amount == null && emp.federal_claim_code != null
        ? Number(emp.federal_claim_code) : undefined,
      provincialClaim: emp.provincial_claim_amount ?? undefined,
      provincialClaimCode: emp.provincial_claim_amount == null && emp.provincial_claim_code != null
        ? Number(emp.provincial_claim_code) : undefined,
      taxExempt: emp.tax_exempt === "true" || emp.tax_exempt === true as unknown as string,
      cppExempt: emp.cpp_exempt === "true" || emp.cpp_exempt === true as unknown as string,
      eiExempt: emp.ei_exempt === "true" || emp.ei_exempt === true as unknown as string,
      ytd: {
        cpp: ytd.cpp, cpp2: ytd.cpp2, ei: ytd.ei, qpip: ytd.qpip,
        pensionable: ytd.pensionable, nonPeriodic: ytd.non_periodic,
        nonPeriodicCppEnhancedDeductions: ytd.f5b,
      },
    };
    const statutory = calculateT4127(t4127Input);

    pushStatutory("income_tax", "deduction", "Income tax", statutory.totalTax, 110);
    pushStatutory("cpp", "deduction", province === "QC" ? "QPP" : "CPP", statutory.cpp, 120);
    pushStatutory("cpp2", "deduction", province === "QC" ? "QPP2" : "CPP2", statutory.cpp2, 130);
    pushStatutory("ei", "deduction", "EI", statutory.ei, 140);
    pushStatutory("qpip", "deduction", "QPIP", statutory.qpip, 150);
    pushStatutory("cpp", "employer_contribution",
      province === "QC" ? "QPP (employer)" : "CPP (employer)", statutory.cppEmployer, 210);
    pushStatutory("ei", "employer_contribution", "EI (employer)", statutory.eiEmployer, 220);
    pushStatutory("qpip", "employer_contribution", "QPIP (employer)", statutory.qpipEmployer, 230);

    // Québec provincial income tax — TP-1015.F-V, computed by the QC engine
    // from the same inputs plus the T4127 arm's own QPP outputs (C, C2, S3).
    // Its line carries assessedOn 'taxable_income', so the protection
    // fixpoint re-derives it exactly as it re-derives federal income_tax.
    let qcFactors: Record<string, string> = {};
    if (province === "QC") {
      const qc = calculateTp1015({
        payDate: run.pay_date, periodsPerYear: P,
        income, nonPeriodic,
        pensionDeductions: deduction("pension_f"),
        qpp: statutory.cpp, qpp2: statutory.cpp2,
        pensionable,
        // TP-1015.3-V carries an AMOUNT (line 10), never a claim code —
        // provincial_claim_amount is E; an unset amount uses the guide's
        // basic-personal-amount default inside the engine.
        personalCredits: emp.provincial_claim_amount ?? undefined,
        // TP-1016-V authorized annual credits (variable K1) — the provincial
        // analogue field, dead for QC under T4127 (no provincial T2 exists).
        authorizedAnnualCredits: emp.authorized_provincial_credits ?? undefined,
        taxExempt: emp.tax_exempt === "true" || emp.tax_exempt === true as unknown as string,
        ytd: { nonPeriodic: ytd.non_periodic, csb: ytd.qc_csb },
      });
      pushStatutory("qc_income_tax", "deduction", "Québec income tax", qc.totalTax, 115);
      qcFactors = qc.factors;
    }

    factors = {
      ...statutory.factors,
      ...qcFactors,
      B: nonPeriodic, I: income, PI: pensionable, IE: insurable,
      QPIP: statutory.qpip, EI_ER: statutory.eiEmployer, QPIP_ER: statutory.qpipEmployer,
      ...(cmp(wcbAssessable, "0") > 0 ? { WCB: wcbAmount, WCB_EARN: wcbAssessable } : {}),
      ...(cmp(ehtEarnings, "0") > 0 ? { EHT: ehtAmount, EHT_EARN: ehtEarnings } : {}),
    };
  }
  // What the earnings-assessed lines looked like the first time the pass ran,
  // so the loop can be held to leaving them alone.
  firstEarningsAssessed ??= earningsAssessedSnapshot();
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
            `deduction protection did not converge for ${emp.display_name ?? employeePartyId}`
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

  // The loop has settled: hold the pack's `earnings` declarations to their
  // word before any of it reaches the stub. A levy that moved was recomputed
  // from something a deduction changed, which is exactly the failure the
  // declaration exists to make impossible.
  assertEarningsAssessedStable(
    emp.display_name ?? employeePartyId,
    firstEarningsAssessed ?? [],
    earningsAssessedSnapshot(),
  );

  // Shortfalls are derived from what the stub FINALLY deducts, so the settle
  // branch reports the settled amount's balance rather than the last pass's.
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

  const stub = (await tx.execute(sql`
    insert into pay_stubs (org_id, pay_run_document_id, employee_party_id, province,
                           periods_per_year, pay_date, tax_year, federal_claim, provincial_claim,
                           currency_code, gross, pensionable_earnings, insurable_earnings,
                           net_pay, employer_cost, vacation_accrued, factors, payment_method,
                           created_by, updated_by)
    values (${orgId}, ${documentId}, ${employeePartyId}, ${province}, ${P},
            ${run.pay_date}, ${taxYear}, ${factors.TC ?? "0"}, ${factors.TCP ?? "0"},
            ${run.doc_currency}, ${gross}, ${pensionable}, ${insurable},
            ${net}, ${employerCost}, ${vacationAccrued}, ${JSON.stringify(factors)}::jsonb,
            ${paymentMethod},
            ${actorId}, ${actorId})
    returning id
  `)) as unknown as { rows: { id: string }[] };
  const stubId = stub.rows[0]!.id;
  for (const line of lines) {
    await tx.execute(sql`
      insert into pay_stub_lines (org_id, stub_id, component_id, kind, description, hours, rate,
                                  amount, project_id, department_id, time_type_id, sequence,
                                  created_by, updated_by)
      values (${orgId}, ${stubId}, ${line.componentId}, ${line.kind}, ${line.description},
              ${line.hours ?? null}, ${line.rate ?? null}, ${line.amount},
              ${line.projectId ?? null}, ${line.departmentId ?? null}, ${line.timeTypeId ?? null},
              ${line.sequence}, ${actorId}, ${actorId})
    `);
  }

  // Ledger movements land only once the stub rows exist. The call replaces
  // THIS EMPLOYEE'S prior movements on this run and nobody else's — it is made
  // once per employee, so a run-scoped replacement here would erase every
  // previously calculated employee's bank. It runs unconditionally: an
  // employee whose recompute produced no movements must still have their stale
  // rows cleared.
  await recordEntitlementMovements(tx, {
    orgId, actorId, payRunDocumentId: documentId,
    employeePartyIds: [employeePartyId],
    movements: entitlementMovements,
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
  tx: Pick<typeof db, "execute">, orgId: string, documentId: string,
): Promise<{ legs: PayRunGlLeg[]; debitTotal: string }> {
  {
    const settings = await payrollSettings(orgId);
    const costing = await laborCostingSettings(orgId);
    const control = (await tx.execute(sql`
      select settings->'controlAccounts' as c, settings->'payroll' as p from orgs where id = ${orgId}
    `)) as unknown as {
      rows: { c: Record<string, string | null> | null; p: Record<string, unknown> | null }[];
    };
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

    const stubLines = (await tx.execute(sql`
      select s.employee_party_id, l.kind, l.description, l.amount, l.project_id, l.department_id,
             c.system_key, c.expense_account_id, c.liability_account_id, s.net_pay
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id
        left join pay_components c on c.id = l.component_id
       where l.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
       order by s.employee_party_id, l.sequence
    `)) as unknown as { rows: Record<string, string | null>[] };
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
        const liability = line.liability_account_id ?? statutoryLiability(line.system_key);
        if (!liability) {
          throw new PayrollError(
            `deduction "${line.description}" has no liability account — set it in Payroll setup → Accounts & posting`,
          );
        }
        accumulate(liability, neg(amount), line.description ?? "Deduction");
      } else {
        const liability = line.liability_account_id ?? statutoryLiability(line.system_key);
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
 */
export async function commitPayRun(input: {
  orgId: string; documentId: string; actorId: string;
}): Promise<{ lines: number }> {
  const { orgId, documentId, actorId } = input;
  return await db.transaction(async (tx) => {
    const runRows = (await tx.execute(sql`
      select r.*, d.status as doc_status from pay_runs r
      join documents d on d.id = r.document_id
      where r.org_id = ${orgId} and r.document_id = ${documentId} for update
    `)) as unknown as { rows: Record<string, string>[] };
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (run.run_status !== "calculated") throw new PayrollError("calculate the pay run before committing");
    // Approval moves the document from draft to approved, so both are
    // committable; anything else (posted, voided) is not.
    if (run.doc_status !== "draft" && run.doc_status !== "approved") {
      throw new PayrollError("pay run document is not editable");
    }
    // Money must not move before the run is approved. Dynamic import keeps the
    // module cycle out of the engine's load order (same idiom as
    // flows/documents-adapter.ts → document-void.ts).
    const { assertPayRunApprovalReleased } = await import("./payroll-approval.ts");
    await assertPayRunApprovalReleased(orgId, documentId);

    const { legs, debitTotal } = await payRunGlLegs(tx, orgId, documentId);

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

    // Claim ONLY the time whose hours were actually priced onto this run's
    // stubs. Claiming "every approved entry in the period for anyone with a
    // stub" claimed hours the run never paid: a `bonus` run prices no time at
    // all, yet committing one before the regular run marked the whole period's
    // hours as paid — so every hourly employee then calculated at $0 while
    // readiness still reported the hours as present.
    //
    // The match is the calculation's own grouping key (time type × project ×
    // department, per employee), which is why a wage line for that group
    // existing is exactly the statement "this run paid these hours". It
    // therefore also excludes, correctly and without a special case: salaried
    // employees (whose time is costed, never priced), time types flagged
    // exclude_from_wages, and any group a `replace_component` adjustment
    // overrode.
    await tx.execute(sql`
      update time_entries te set payroll_batch_ref = ${documentId}
       where te.org_id = ${orgId} and te.status = 'approved'
         and te.worked_on between ${run.period_start} and ${run.period_end}
         and te.payroll_batch_ref is null
         and exists (
           select 1
             from pay_stub_lines l
             join pay_stubs s on s.id = l.stub_id
             join pay_components c on c.id = l.component_id
            where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
              and s.employee_party_id = te.employee_party_id
              and c.system_key in ('base_pay', 'overtime')
              and l.hours is not null
              and l.time_type_id is not distinct from te.time_type_id
              and l.project_id is not distinct from te.project_id
              and l.department_id is not distinct from te.department_id
         )
    `);
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
  orgId: string, documentId: string,
): Promise<{ legs: (PayRunGlLeg & {
  accountLabel: string; partyName: string | null; projectName: string | null;
})[]; debitTotal: string }> {
  const runRows = (await db.execute(sql`
    select r.run_status from pay_runs r
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `)) as unknown as { rows: { run_status: string }[] };
  if (!runRows.rows[0]) throw new PayrollError("pay run not found");
  if (runRows.rows[0].run_status === "draft") {
    throw new PayrollError("calculate the pay run to preview its GL impact");
  }
  const { legs, debitTotal } = await payRunGlLegs(db, orgId, documentId);
  const accountIds = [...new Set(legs.map((l) => l.accountId))];
  const partyIds = [...new Set(legs.map((l) => l.partyId).filter(Boolean))] as string[];
  const projectIds = [...new Set(legs.map((l) => l.projectId).filter(Boolean))] as string[];
  const [accounts, parties, projects] = (await Promise.all([
    db.execute(sql`select id, number, name from accounts
                    where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`),
    partyIds.length
      ? db.execute(sql`select id, display_name from parties
                        where org_id = ${orgId} and id = any(${`{${partyIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
    projectIds.length
      ? db.execute(sql`select id, name from projects
                        where org_id = ${orgId} and id = any(${`{${projectIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
  ])) as unknown as [
    { rows: { id: string; number: string | null; name: string }[] },
    { rows: { id: string; display_name: string }[] },
    { rows: { id: string; name: string }[] },
  ];
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
