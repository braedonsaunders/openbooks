import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { businessToday } from "./business-date.ts";
import { cmp, roundMoney } from "./money.ts";
import { PayrollError } from "./payroll-error.ts";
import {
  entitlementPlans,
  vacationPlanOf,
  type Executor,
} from "./payroll-entitlements-db.ts";
import { type EntitlementPlan } from "./payroll-entitlements-types.ts";

/* ------------------------------------------------------------------ */
/* Mid-year adoption: opening balances for a bank                       */
/* ------------------------------------------------------------------ */

/**
 * The third dimension of a mid-year carry-in (the statutory and per-component
 * ones live in engine/src/payroll-opening-balances.ts).
 *
 * An employer adopting OpenBooks mid-year does not only carry in CPP and EI.
 * Every employee also arrives holding a vacation bank and, often, banked
 * overtime — a real liability the employer already owes. Since vacation moved
 * onto the entitlement ledger, `payroll_opening_balances.vacation_balance` is
 * dead to the engine and there was NO load path at all: every bank started at
 * zero, so the balance sheet understated the liability, and a termination in the
 * first year paid out only what accrued after adoption. For a ten-year employee
 * that is most of their entitlement, silently.
 *
 * Shape, and why it is not a table:
 *
 *  - the carry-in IS an `entitlement_ledger` movement with `kind = 'opening'`,
 *    which the schema already reserved and the vacation migration already
 *    writes. Balance = SUM(ledger), and a separate opening table would be a
 *    second source of truth for the same number;
 *  - it is NOT year-scoped, unlike the statutory carry-in. A bank has one
 *    lifetime balance, not an annual one, so `entitlement_ledger_opening` is
 *    unique on (org, plan, employee) with no tax year — and the UI keeps it out
 *    of the year-scoped grid for exactly that reason;
 *  - `movementDate` is the adoption date. It matters: the pay run sums
 *    `movement_date <= pay_date`, so a carry-in dated after a run is invisible
 *    to it, and one dated before a COMMITTED run would restate a balance that
 *    run already paid from. That is the lock, below.
 */
export interface EntitlementOpeningLock {
  documentNumber: string | null;
  payDate: string;
}

export interface EntitlementOpeningRow {
  employeePartyId: string;
  employeeName: string;
  employeeNumber: string | null;
  /** planId → carried-in amount, in the plan's unit. Only where one exists. */
  amounts: Record<string, string>;
  /** planId → the adoption date the carry-in is dated. */
  dates: Record<string, string>;
  /** planId → the committed run that froze it, where one has. */
  locked: Record<string, EntitlementOpeningLock>;
  /**
   * Non-zero `payroll_opening_balances.vacation_balance` with no matching
   * opening movement: a legacy carry-in nobody migrated. Surfaced rather than
   * left to rot — it is money the employer owes that no balance shows.
   */
  legacyVacationBalance: string | null;
}

export interface EntitlementOpeningsResult {
  /** Active plans, in code order — the columns of the grid. */
  plans: EntitlementPlan[];
  rows: EntitlementOpeningRow[];
  /** Employees carrying at least one opening. */
  entered: number;
  /** The date new carry-ins will be dated unless the operator changes it. */
  asOf: string;
  /**
   * Employees a committed run on or after `asOf` already paid, so a NEW
   * carry-in dated then would restate a balance that run computed from.
   */
  blocked: Record<string, EntitlementOpeningLock>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function assertMovementDate(value: unknown): string {
  const date = String(value ?? "").trim().slice(0, 10);
  if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new PayrollError(`"${String(value)}" is not a date (YYYY-MM-DD)`);
  }
  return date;
}

/**
 * Openings a committed run has already consumed, per (plan, employee).
 *
 * The test is the ENGINE's read predicate, not a proxy for it:
 * `planBalanceExcludingRun` sums `movement_date <= onDate`, so a committed run
 * included this carry-in exactly when it has a stub for the employee dated on or
 * after the carry-in's movement date. Anything looser would freeze carry-ins no
 * run ever read (blocking a correctable typo behind a void); anything tighter
 * would let an edit restate money that has left the bank.
 */
export async function entitlementOpeningLocks(
  orgId: string,
  executor: Executor = db,
): Promise<Map<string, EntitlementOpeningLock>> {
  const r = (await executor.execute<{ plan_id: string; employee_party_id: string; document_number: string | null; pay_date: string }>(sql`
    select distinct on (l.plan_id, l.employee_party_id)
           l.plan_id, l.employee_party_id, d.document_number, s.pay_date::text as pay_date
      from entitlement_ledger l
      join pay_stubs s on s.org_id = l.org_id and s.employee_party_id = l.employee_party_id
                      and s.pay_date >= l.movement_date
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      left join documents d on d.id = r.document_id and d.org_id = r.org_id
     where l.org_id = ${orgId} and l.kind = 'opening' and r.run_status = 'committed'
     order by l.plan_id, l.employee_party_id, s.pay_date
  `));
  return new Map(
    r.rows.map((row) => [
      `${row.plan_id}:${row.employee_party_id}`,
      { documentNumber: row.document_number, payDate: row.pay_date },
    ]),
  );
}

/**
 * Employees a committed run on or after `asOf` has already paid. Adding a
 * carry-in dated then would change the balance that run's stub was computed
 * from, which no recalculation can put back — so a NEW opening is refused for
 * them, with the run named.
 */
export async function entitlementOpeningBlocks(
  orgId: string,
  asOf: string,
  executor: Executor = db,
): Promise<Map<string, EntitlementOpeningLock>> {
  const r = (await executor.execute<{ employee_party_id: string; document_number: string | null; pay_date: string }>(sql`
    select distinct on (s.employee_party_id)
           s.employee_party_id, d.document_number, s.pay_date::text as pay_date
      from pay_stubs s
      join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
      left join documents d on d.id = r.document_id and d.org_id = r.org_id
     where s.org_id = ${orgId} and r.run_status = 'committed' and s.pay_date >= ${asOf}
     order by s.employee_party_id, s.pay_date
  `));
  return new Map(
    r.rows.map((row) => [
      row.employee_party_id,
      { documentNumber: row.document_number, payDate: row.pay_date },
    ]),
  );
}

/**
 * Every active employee's bank carry-ins, plus the plans that need one.
 *
 * Employees WITHOUT a carry-in are returned too, exactly as the statutory grid
 * does: an empty screen that has to be discovered person by person is how a
 * ten-year employee's vacation bank gets left at zero.
 */
export async function entitlementOpenings(
  orgId: string,
  opts: { asOf?: string } = {},
): Promise<EntitlementOpeningsResult> {
  const asOf = opts.asOf ? assertMovementDate(opts.asOf) : await businessToday(orgId);
  const plans = await entitlementPlans(orgId);

  const people = (await db.execute<Record<string, unknown>>(sql`
    select p.id as employee_party_id, p.display_name as employee_name, er.employee_number,
           coalesce((
             select b.vacation_balance from payroll_opening_balances b
              where b.org_id = p.org_id and b.employee_party_id = p.id
                and b.vacation_balance <> 0
              order by b.tax_year desc limit 1), 0)::text as legacy_vacation
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join employee_roles er on er.party_id = p.id and er.org_id = prof.org_id
     where prof.org_id = ${orgId} and prof.is_active and p.is_active
     order by p.display_name
  `));

  const openings = (await db.execute<{ plan_id: string; employee_party_id: string; amount: string; movement_date: string }>(sql`
    select plan_id, employee_party_id, amount::text as amount, movement_date::text as movement_date
      from entitlement_ledger
     where org_id = ${orgId} and kind = 'opening'
  `));
  const byEmployee = new Map<string, typeof openings.rows>();
  for (const row of openings.rows) {
    byEmployee.set(row.employee_party_id, [...(byEmployee.get(row.employee_party_id) ?? []), row]);
  }

  const locks = await entitlementOpeningLocks(orgId);
  const blocks = await entitlementOpeningBlocks(orgId, asOf);
  const vacationPlan = vacationPlanOf(plans);

  const rows: EntitlementOpeningRow[] = people.rows.map((raw) => {
    const employeePartyId = String(raw.employee_party_id);
    const amounts: Record<string, string> = {};
    const dates: Record<string, string> = {};
    const locked: Record<string, EntitlementOpeningLock> = {};
    for (const row of byEmployee.get(employeePartyId) ?? []) {
      amounts[row.plan_id] = roundMoney(String(row.amount), 4);
      dates[row.plan_id] = String(row.movement_date).slice(0, 10);
      const lock = locks.get(`${row.plan_id}:${employeePartyId}`);
      if (lock) locked[row.plan_id] = lock;
    }
    // Only a legacy value with nothing carried in against the vacation plan is
    // unmigrated. Once the opening exists the column has been dealt with.
    const legacy = roundMoney(String(raw.legacy_vacation ?? "0"), 4);
    const unmigrated = cmp(legacy, "0") !== 0
      && (vacationPlan === null || amounts[vacationPlan.id] === undefined);
    return {
      employeePartyId,
      employeeName: String(raw.employee_name ?? ""),
      employeeNumber: raw.employee_number == null ? null : String(raw.employee_number),
      amounts,
      dates,
      locked,
      legacyVacationBalance: unmigrated ? legacy : null,
    };
  });

  return {
    plans,
    rows,
    entered: rows.filter((row) => Object.keys(row.amounts).length > 0).length,
    asOf,
    blocked: Object.fromEntries(blocks),
  };
}
