import { sql, type SQL } from "drizzle-orm";
import { db } from "./db.ts";

/**
 * How an employee's net pay leaves the bank.
 *
 * An employee with no bank details is NOT an exception to wave through — they
 * are paid by cheque. This module is the ONE place that decides which rail a
 * person is on, so readiness, funding, the bank file, the cheque print run and
 * the payment posting can never disagree about who is getting what.
 *
 * There are exactly two payroll rails. `parties.payment_method` also carries
 * `card`, `cash` and `other`, which are AP/receipt concepts: wages cannot be
 * paid on a card, and this product has no cash-disbursement rail. Anything
 * explicitly NOT `eft` therefore means "hand this person a negotiable
 * instrument", which is a cheque. That mapping is deliberate and one-way — it
 * can never silently promote somebody ONTO the EFT rail.
 */
export const PAYROLL_PAYMENT_METHODS = ["eft", "cheque"] as const;
export type PayrollPaymentMethod = (typeof PAYROLL_PAYMENT_METHODS)[number];

export function isPayrollPaymentMethod(value: unknown): value is PayrollPaymentMethod {
  return value === "eft" || value === "cheque";
}

/** Where the resolved rail came from — shown beside the employee in the UI. */
export type PaymentMethodSource =
  /** employee_payroll_profiles.payment_method — the payroll-owned override. */
  | "profile"
  /** parties.payment_method — the party's standing preference. */
  | "party"
  /** Nothing configured: EFT if the bank details exist, otherwise cheque. */
  | "default"
  /** Configured EFT, no approved bank details, org falls back to cheque. */
  | "eftFallback";

export interface ResolvedPaymentMethod {
  /** The rail this pay will actually go out on. */
  method: PayrollPaymentMethod;
  /** What was configured, before any fallback. */
  configured: PayrollPaymentMethod;
  source: PaymentMethodSource;
  /** Configured for EFT but has no approved bank details. */
  missingBankDetails: boolean;
  /**
   * True when the employee is stuck: configured EFT, no approved bank details,
   * and the org does not allow the cheque fallback. This is the only genuinely
   * broken case — there is no route for the money — and it is a run blocker.
   */
  unpayable: boolean;
}

export interface PaymentMethodInput {
  /** employee_payroll_profiles.payment_method (payroll override). */
  profileMethod?: string | null;
  /** parties.payment_method (eft | cheque | card | cash | other). */
  partyMethod?: string | null;
  /** An active, APPROVED party bank account exists. */
  hasApprovedBankDetails: boolean;
  /** orgs.settings.payroll.eftFallbackToCheque. */
  fallbackToCheque: boolean;
}

/**
 * Resolve one employee's rail. Pure — the SQL fragment below and every caller
 * must agree with this function, which is why the tests exercise it directly.
 *
 * The ladder:
 *   1. the payroll override on the profile, when set;
 *   2. otherwise the party's standing preference — `eft` means EFT, every
 *      other explicit value means a physical instrument, i.e. cheque;
 *   3. otherwise nothing is configured: EFT when approved bank details exist,
 *      cheque when they do not.
 *
 * Then the safety net: an employee configured for EFT with no approved bank
 * details is paid by cheque instead (a warning), unless the org has turned the
 * fallback off, in which case the run is blocked rather than quietly rerouted.
 * Either way the employee always ends with a rail — never nothing.
 */
export function resolvePayrollPaymentMethod(input: PaymentMethodInput): ResolvedPaymentMethod {
  const { hasApprovedBankDetails, fallbackToCheque } = input;
  let configured: PayrollPaymentMethod;
  let source: PaymentMethodSource;
  if (isPayrollPaymentMethod(input.profileMethod)) {
    configured = input.profileMethod;
    source = "profile";
  } else if (input.partyMethod != null && input.partyMethod !== "") {
    configured = input.partyMethod === "eft" ? "eft" : "cheque";
    source = "party";
  } else {
    configured = hasApprovedBankDetails ? "eft" : "cheque";
    source = "default";
  }

  const missingBankDetails = configured === "eft" && !hasApprovedBankDetails;
  if (!missingBankDetails) {
    return { method: configured, configured, source, missingBankDetails: false, unpayable: false };
  }
  return fallbackToCheque
    ? { method: "cheque", configured, source: "eftFallback", missingBankDetails: true, unpayable: false }
    : { method: "eft", configured, source, missingBankDetails: true, unpayable: true };
}

/**
 * The same ladder as SQL, for the roster/readiness/funding queries that resolve
 * a whole population at once. Returns the RESOLVED rail (fallback applied), so
 * `= 'eft'` is always "is on the bank file".
 *
 * Keep this in lock-step with `resolvePayrollPaymentMethod` — the shared test
 * asserts both give the same answer for every combination.
 */
export function resolvedPaymentMethodSql(cols: {
  profileMethod: SQL;
  partyMethod: SQL;
  hasBank: SQL;
  fallbackToCheque: boolean;
}): SQL {
  const configured = sql`
    case when ${cols.profileMethod} in ('eft', 'cheque') then ${cols.profileMethod}
         when coalesce(${cols.partyMethod}, '') <> '' then
           case when ${cols.partyMethod} = 'eft' then 'eft' else 'cheque' end
         when ${cols.hasBank} then 'eft'
         else 'cheque' end`;
  if (!cols.fallbackToCheque) return sql`(${configured})`;
  return sql`(case when (${configured}) = 'eft' and not ${cols.hasBank} then 'cheque' else (${configured}) end)`;
}

export interface PayrollPaymentMethodSettings {
  /**
   * Pay an EFT-configured employee by cheque when they have no approved bank
   * details, instead of blocking the run. On by default: a payroll that stops
   * because one void cheque has not been keyed yet fails the other 200 people.
   */
  eftFallbackToCheque: boolean;
}

export async function payrollPaymentMethodSettings(
  orgId: string,
): Promise<PayrollPaymentMethodSettings> {
  const r = (await db.execute<{ v: unknown }>(sql`
    select settings#>'{payroll,eftFallbackToCheque}' as v from orgs where id = ${orgId}
  `));
  // Absent = on. Only an explicit `false` turns the safety net off.
  return { eftFallbackToCheque: r.rows[0]?.v !== false };
}

export interface EmployeePaymentMethodRow extends ResolvedPaymentMethod {
  employeePartyId: string;
  name: string;
}

/**
 * Every employee on a pay schedule with their resolved rail. Used by the
 * scope roster; the run's own population predicates are applied by the caller.
 */
export async function schedulePaymentMethods(
  orgId: string,
  payScheduleId: string,
): Promise<EmployeePaymentMethodRow[]> {
  const { eftFallbackToCheque } = await payrollPaymentMethodSettings(orgId);
  const rows = (await db.execute<{ id: string; name: string; profile_method: string | null; party_method: string | null; has_bank: boolean }>(sql`
    select p.id, p.display_name as name, prof.payment_method as profile_method,
           p.payment_method as party_method,
           exists (
             select 1 from party_bank_accounts b
              where b.org_id = prof.org_id and b.party_id = p.id
                and b.is_active and b.approval_status = 'approved') as has_bank
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
     where prof.org_id = ${orgId} and prof.pay_schedule_id = ${payScheduleId} and prof.is_active
     order by p.display_name
  `));
  return rows.rows.map((row) => ({
    employeePartyId: row.id,
    name: row.name,
    ...resolvePayrollPaymentMethod({
      profileMethod: row.profile_method,
      partyMethod: row.party_method,
      hasApprovedBankDetails: row.has_bank,
      fallbackToCheque: eftFallbackToCheque,
    }),
  }));
}

/**
 * The rail each CALCULATED stub went out on.
 *
 * Prefers the snapshot written at calculate time; a stub calculated before this
 * column existed falls back to a live resolution so historical runs still split
 * sensibly instead of vanishing from both the bank file and the cheque batch.
 */
export async function stubPaymentMethods(
  orgId: string,
  documentId: string,
): Promise<(EmployeePaymentMethodRow & { stubId: string; netPay: string; chequeNumber: string | null })[]> {
  const { eftFallbackToCheque } = await payrollPaymentMethodSettings(orgId);
  const rows = (await db.execute<{
      stub_id: string; employee_party_id: string; name: string; net_pay: string;
      stub_method: string | null; cheque_number: string | null;
      profile_method: string | null; party_method: string | null; has_bank: boolean;
    }>(sql`
    select s.id as stub_id, s.employee_party_id, p.display_name as name,
           s.net_pay::text as net_pay, s.payment_method as stub_method, s.cheque_number,
           prof.payment_method as profile_method, p.payment_method as party_method,
           exists (
             select 1 from party_bank_accounts b
              where b.org_id = s.org_id and b.party_id = p.id
                and b.is_active and b.approval_status = 'approved') as has_bank
      from pay_stubs s
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
      left join employee_payroll_profiles prof
        on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
     order by p.display_name
  `));
  return rows.rows.map((row) => {
    const live = resolvePayrollPaymentMethod({
      profileMethod: row.profile_method,
      partyMethod: row.party_method,
      hasApprovedBankDetails: row.has_bank,
      fallbackToCheque: eftFallbackToCheque,
    });
    const resolved: ResolvedPaymentMethod = isPayrollPaymentMethod(row.stub_method)
      ? { ...live, method: row.stub_method }
      : live;
    return {
      stubId: row.stub_id,
      employeePartyId: row.employee_party_id,
      name: row.name,
      netPay: row.net_pay,
      chequeNumber: row.cheque_number,
      ...resolved,
    };
  });
}
