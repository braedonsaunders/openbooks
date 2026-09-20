import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import {
  loadHolidayOverrides,
  resolveObservedHolidays,
  statutoryHolidayPayRule,
  type HolidayOverride,
  type StatutoryHolidayEligibilityFacts,
} from "./holidays.ts";
import {
  holidayPayLookbackBasis,
  jurisdictionKey,
  labourJurisdictionProblem,
  payrollJurisdictionDeclared,
} from "./packs.ts";

/**
 * Stored statutory-holiday attestation facts (migration 0181).
 *
 * Two different kinds of fact, stored in two different places:
 * - `paidOnCommission` is a STANDING employment attribute on
 *   employee_payroll_profiles (nullable: null = unanswered, and unanswered
 *   fails closed exactly like a missing per-request entry).
 * - the last-and-first-shift absence assertion is PER (run, employee,
 *   holiday) in pay_run_holiday_assertions, so a later period never inherits
 *   an earlier run's answer.
 *
 * The per-request `holidayEligibility` map still wins where both exist: it is
 * the override, the stored value the fallback. The merge below is what the
 * calculate surface passes to the engine, so the engine itself never changes
 * shape — it keeps receiving one explicit map and failing closed on a
 * missing entry.
 */

export interface StoredHolidayFacts {
  /** Employees with an ANSWERED standing commission status. */
  commissions: Map<string, boolean>;
  /** employee party id → (`holidayKey|holidayDate` → asserted value). */
  assertions: Map<string, Map<string, boolean>>;
}

/** Inner key for one holiday occurrence. Both halves are needed: one period
 *  can hold several paid holidays. */
export const holidayOccurrenceKey = (holidayKey: string, holidayDate: string): string =>
  `${holidayKey}|${holidayDate}`;

/**
 * Load this run's stored facts for its roster. Commission answers come from
 * the standing profile column (answered rows only — null stays unanswered);
 * absence assertions come from this run's own rows (a later run cannot see
 * an earlier run's).
 */
export async function loadStoredHolidayFacts(
  tx: Pick<typeof db, "execute">,
  args: { orgId: string; documentId: string; employeePartyIds: readonly string[] },
): Promise<StoredHolidayFacts> {
  const { orgId, documentId, employeePartyIds } = args;
  const commissions = new Map<string, boolean>();
  const assertions = new Map<string, Map<string, boolean>>();
  if (employeePartyIds.length === 0) return { commissions, assertions };
  const [profileRows, assertionRows] = await Promise.all([
    tx.execute<{ employee_party_id: string; paid_on_commission: boolean }>(sql`
      select employee_party_id, paid_on_commission
        from employee_payroll_profiles
       where org_id = ${orgId}
         and employee_party_id in (${sql.join(employeePartyIds.map((id) => sql`${id}::uuid`), sql`, `)})
         and paid_on_commission is not null`),
    tx.execute<{
      employee_party_id: string; holiday_key: string; holiday_date: string | Date;
      absent_without_consent: boolean;
    }>(sql`
      select employee_party_id, holiday_key, holiday_date::text as holiday_date, absent_without_consent
        from pay_run_holiday_assertions
       where org_id = ${orgId} and pay_run_document_id = ${documentId}`),
  ]);
  for (const row of profileRows.rows) {
    commissions.set(row.employee_party_id, assertStoredBoolean(row.paid_on_commission));
  }
  for (const row of assertionRows.rows) {
    const date = String(row.holiday_date).slice(0, 10);
    let perEmployee = assertions.get(row.employee_party_id);
    if (!perEmployee) {
      perEmployee = new Map<string, boolean>();
      assertions.set(row.employee_party_id, perEmployee);
    }
    perEmployee.set(holidayOccurrenceKey(row.holiday_key, date), row.absent_without_consent);
  }
  return { commissions, assertions };
}

/** The loader's query already filters nulls, so a non-boolean here is a
 *  driver surprise — refused rather than coerced into an answer. */
function assertStoredBoolean(value: boolean): boolean {
  if (typeof value !== "boolean") {
    throw new PayrollError("stored commission-pay status is unreadable — re-answer it on the employee record");
  }
  return value;
}

/**
 * Merge the per-request map over the stored facts. The request wins per
 * employee per fact; the stored value fills what the request omits; an
 * answer missing from both stays missing and the engine fails closed on it.
 *
 * The engine takes ONE absence value per employee per period, while storage
 * is per holiday occurrence. Where several holidays in the period demand the
 * assertion, the stored rows collapse to a single value only when EVERY
 * demanding occurrence is asserted AND unanimous — anything less leaves the
 * fact missing and the engine refuses by name, because a partial or split
 * answer is not the single coherent answer the engine consumes.
 */
export function mergeHolidayEligibility(
  perRequest: Readonly<Record<string, StatutoryHolidayEligibilityFacts>> | undefined,
  stored: StoredHolidayFacts,
  demandingByEmployee: ReadonlyMap<string, readonly DemandingHoliday[]>,
): Record<string, StatutoryHolidayEligibilityFacts> {
  const merged: Record<string, StatutoryHolidayEligibilityFacts> = {};
  const employeeIds = new Set<string>([
    ...Object.keys(perRequest ?? {}),
    ...stored.commissions.keys(),
    ...stored.assertions.keys(),
    ...demandingByEmployee.keys(),
  ]);
  for (const employeeId of employeeIds) {
    const request = perRequest?.[employeeId];
    const entry: StatutoryHolidayEligibilityFacts = {};
    const commission = request?.paidOnCommission ?? stored.commissions.get(employeeId);
    if (commission !== undefined) entry.paidOnCommission = commission;
    if (request?.absentWithoutConsent !== undefined) {
      entry.absentWithoutConsent = request.absentWithoutConsent;
    } else {
      const occurrences = (demandingByEmployee.get(employeeId) ?? [])
        .filter((holiday) => holiday.needsAbsenceAssertion)
        .map((holiday) => holidayOccurrenceKey(holiday.key, holiday.date));
      const perEmployee = stored.assertions.get(employeeId);
      const values = occurrences.map((occurrence) => perEmployee?.get(occurrence));
      if (occurrences.length > 0 && values.every((value) => value !== undefined)) {
        const first = values[0]!;
        if (values.every((value) => value === first)) entry.absentWithoutConsent = first;
      }
    }
    if (entry.paidOnCommission !== undefined || entry.absentWithoutConsent !== undefined) {
      merged[employeeId] = entry;
    }
  }
  return merged;
}

/**
 * File (or re-file) one absence assertion. Upserts on the once-per-holiday
 * key: re-asserting the same holiday replaces the answer, it never
 * duplicates. Returns the stored row's holiday identity for the caller.
 */
export async function recordHolidayAssertion(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; employeePartyId: string;
    holidayKey: string; holidayDate: string; absentWithoutConsent: boolean;
    actorId: string;
  },
): Promise<{ holidayKey: string; holidayDate: string }> {
  const { orgId, documentId, employeePartyId, holidayKey, holidayDate, absentWithoutConsent, actorId } = args;
  if (holidayKey.trim().length === 0) throw new PayrollError("holiday key is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayDate)) throw new PayrollError("holiday date must be YYYY-MM-DD");
  await tx.execute(sql`
    insert into pay_run_holiday_assertions
      (org_id, pay_run_document_id, employee_party_id, holiday_key, holiday_date,
       absent_without_consent, created_by, updated_by)
    values (${orgId}, ${documentId}, ${employeePartyId}, ${holidayKey}, ${holidayDate},
      ${absentWithoutConsent}, ${actorId}, ${actorId})
    on conflict (org_id, pay_run_document_id, employee_party_id, holiday_key, holiday_date)
    do update set absent_without_consent = excluded.absent_without_consent,
                  updated_at = greatest(clock_timestamp(), pay_run_holiday_assertions.updated_at + interval '1 microsecond'),
                  updated_by = excluded.updated_by`);
  return { holidayKey, holidayDate };
}

export interface DemandingHoliday {
  key: string;
  date: string;
  name: string;
  needsCommissionStatus: boolean;
  needsAbsenceAssertion: boolean;
}

/**
 * The paid holidays in a period that DEMAND an explicit fact, for one
 * employee — the same declarations the engine throws on, read without
 * throwing, so a surface can say what is missing before calculating.
 * Mirrors statutoryHolidayLinesForStub's jurisdiction derivation (the
 * employment attribute wins over the region derivation; an undeclared key is
 * refused outright), then asks each paid holiday's own rule what it reads.
 */
export async function demandingHolidays(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    country: string; province: string; labourJurisdiction: string | null;
    employeeName: string; periodStart: string; periodEnd: string;
  },
): Promise<DemandingHoliday[]> {
  const { orgId, country, province, labourJurisdiction, employeeName, periodStart, periodEnd } = args;
  const problem = labourJurisdictionProblem(country, labourJurisdiction);
  if (problem) {
    throw new PayrollError(`${employeeName} has a labour jurisdiction this payroll cannot honour — ${problem}`);
  }
  const jurisdiction = jurisdictionKey(country, province, labourJurisdiction);
  if (!payrollJurisdictionDeclared(jurisdiction)) return [];
  const overrides = await loadHolidayOverrides(tx, orgId, jurisdiction);
  return demandingHolidaysForJurisdiction(jurisdiction, periodStart, periodEnd, overrides);
}

/**
 * Pure half of demandingHolidays: which paid holidays in the period demand
 * an explicit fact, from an already-resolved jurisdiction and its overrides.
 * A rule with no transcribed edition for the holiday's date throws — callers
 * that must never break a calculation catch per employee and read it as "no
 * demanding holidays" (the engine's own pass will refuse by name).
 */
export function demandingHolidaysForJurisdiction(
  jurisdiction: string,
  periodStart: string,
  periodEnd: string,
  overrides: readonly HolidayOverride[],
): DemandingHoliday[] {
  const holidays = resolveObservedHolidays({ jurisdiction, from: periodStart, to: periodEnd, overrides })
    .filter((holiday) => holiday.paid);
  const demanding: DemandingHoliday[] = [];
  for (const holiday of holidays) {
    const rule = statutoryHolidayPayRule(jurisdiction, holiday.date);
    if (!rule) continue;
    const basis = holidayPayLookbackBasis(rule.basis);
    const needsCommissionStatus = basis.kind === "fixed_divisor" && basis.commission !== undefined;
    const needsAbsenceAssertion = rule.qualifying.lastAndFirstScheduledShift === true;
    if (needsCommissionStatus || needsAbsenceAssertion) {
      demanding.push({
        key: holiday.key, date: holiday.date, name: holiday.name,
        needsCommissionStatus, needsAbsenceAssertion,
      });
    }
  }
  return demanding;
}

/**
 * The calculate surface's fallback: stored facts merged UNDER the
 * per-request map for a whole run. Overrides load once per distinct
 * jurisdiction (not per employee), and an employee whose calendar cannot be
 * resolved contributes nothing — the engine's own pass refuses them by name
 * through its existing channel, which this helper must never pre-empt.
 */
export async function storedHolidayEligibilityForRun(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string;
    perRequest: Readonly<Record<string, StatutoryHolidayEligibilityFacts>> | undefined;
  },
): Promise<Record<string, StatutoryHolidayEligibilityFacts>> {
  const { orgId, documentId, perRequest } = args;
  const runRows = (await tx.execute<{ period_start: string; period_end: string; pay_schedule_id: string }>(sql`
    select period_start::text as period_start, period_end::text as period_end, pay_schedule_id
      from pay_runs where org_id = ${orgId} and document_id = ${documentId}`));
  const run = runRows.rows[0];
  if (!run) return { ...(perRequest ?? {}) };
  const roster = (await tx.execute<{
    employee_party_id: string; display_name: string; country: string; province: string;
    labour_jurisdiction: string | null;
  }>(sql`
    select prof.employee_party_id, p.display_name, prof.country, prof.province, prof.labour_jurisdiction
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
     where prof.org_id = ${orgId} and prof.pay_schedule_id = ${run.pay_schedule_id}
       and prof.is_active`)).rows;
  const employeeIds = roster.map((row) => row.employee_party_id);
  const stored = await loadStoredHolidayFacts(tx, { orgId, documentId, employeePartyIds: employeeIds });
  // One overrides load per distinct jurisdiction on the run.
  const overridesByJurisdiction = new Map<string, readonly HolidayOverride[]>();
  const demandingByEmployee = new Map<string, DemandingHoliday[]>();
  for (const row of roster) {
    const problem = labourJurisdictionProblem(row.country, row.labour_jurisdiction);
    if (problem) continue;
    const jurisdiction = jurisdictionKey(row.country, row.province, row.labour_jurisdiction);
    if (!payrollJurisdictionDeclared(jurisdiction)) continue;
    try {
      let overrides = overridesByJurisdiction.get(jurisdiction);
      if (!overrides) {
        overrides = await loadHolidayOverrides(tx, orgId, jurisdiction);
        overridesByJurisdiction.set(jurisdiction, overrides);
      }
      demandingByEmployee.set(
        row.employee_party_id,
        demandingHolidaysForJurisdiction(jurisdiction, run.period_start, run.period_end, overrides),
      );
    } catch {
      // Untranscribed statute, undeclared override key — the engine's own
      // pass refuses by name; no stored fact is merged for this employee.
      continue;
    }
  }
  return mergeHolidayEligibility(perRequest, stored, demandingByEmployee);
}
