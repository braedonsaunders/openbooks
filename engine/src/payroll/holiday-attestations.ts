import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import {
  evidencedEntitledPayDays,
  loadHolidayOverrides,
  resolveObservedHolidays,
  ruleDeclaresOccupationArms,
  statutoryHolidayPayRule,
  type HolidayOverride,
} from "./holidays.ts";
import {
  holidayPayLookbackBasis,
  jurisdictionKey,
  labourJurisdictionProblem,
  payrollJurisdictionDeclared,
} from "./packs.ts";

export { loadStoredHolidayFacts } from "./holiday-facts-store.ts";

/**
 * File (or re-file) one absence assertion. Upserts on the once-per-holiday
 * key: re-asserting the same holiday replaces the answer, it never
 * duplicates. Returns the stored row's holiday identity for the caller.
 */
export async function recordHolidayAssertion(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    documentId: string;
    employeePartyId: string;
    holidayKey: string;
    holidayDate: string;
    absentWithoutConsent: boolean;
    actorId: string;
  },
): Promise<{ holidayKey: string; holidayDate: string }> {
  const {
    orgId,
    documentId,
    employeePartyId,
    holidayKey,
    holidayDate,
    absentWithoutConsent,
    actorId,
  } = args;
  if (holidayKey.trim().length === 0) throw new PayrollError("holiday key is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayDate))
    throw new PayrollError("holiday date must be YYYY-MM-DD");
  // Serialize with calculation and commitment so an answer cannot change
  // after posted payroll, and concurrent edits retain the actual prior state.
  const run = (
    await tx.execute<{ run_status: string }>(
      sql`
    select run_status from pay_runs
     where org_id = ${orgId} and document_id = ${documentId} for update
  `,
      "objects",
    )
  )[0];
  if (!run || (run.run_status !== "draft" && run.run_status !== "calculated")) {
    throw new PayrollError("holiday assertions can only be filed on an uncommitted pay run");
  }
  type AssertionState = {
    id: string;
    absent_without_consent: boolean;
    created_by: string | null;
    updated_by: string | null;
    created_at: Date;
    updated_at: Date;
  };
  const before =
    (
      await tx.execute<AssertionState>(
        sql`
    select id, absent_without_consent, created_by, updated_by, created_at, updated_at
      from pay_run_holiday_assertions
     where org_id = ${orgId} and pay_run_document_id = ${documentId}
       and employee_party_id = ${employeePartyId}
       and holiday_key = ${holidayKey} and holiday_date = ${holidayDate}
     for update
  `,
        "objects",
      )
    )[0] ?? null;
  const updated = await tx.execute<AssertionState>(
    sql`
    insert into pay_run_holiday_assertions
      (org_id, pay_run_document_id, employee_party_id, holiday_key, holiday_date,
       absent_without_consent, created_by, updated_by)
    values (${orgId}, ${documentId}, ${employeePartyId}, ${holidayKey}, ${holidayDate},
      ${absentWithoutConsent}, ${actorId}, ${actorId})
    on conflict (org_id, pay_run_document_id, employee_party_id, holiday_key, holiday_date)
    do update set absent_without_consent = excluded.absent_without_consent,
                  updated_at = greatest(clock_timestamp(), pay_run_holiday_assertions.updated_at + interval '1 microsecond'),
                  updated_by = excluded.updated_by
    returning id, absent_without_consent, created_by, updated_by, created_at, updated_at`,
    "objects",
  );
  if (updated.length !== 1)
    throw new PayrollError("holiday assertion was not recorded — reload the pay run and retry");
  const after = updated[0]!;
  const changes = {
    event: "holiday_absence_assertion",
    reason: "Statutory holiday absence eligibility assessment",
    payRunDocumentId: documentId,
    employeePartyId,
    holidayKey,
    holidayDate,
    before,
    after,
  };
  const audit = await tx.execute<{ id: string }>(
    sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'pay_run_holiday_assertions', ${after.id},
            ${before === null ? "insert" : "update"}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning id
  `,
    "objects",
  );
  if (audit.length !== 1)
    throw new PayrollError(
      "holiday assertion audit was not recorded — reload the pay run and retry",
    );
  return { holidayKey, holidayDate };
}

/** Append-only evidence of an employer's complete day-count assessment. */
export async function recordEntitledDaysAttestation(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    documentId: string;
    employeePartyId: string;
    employeeName: string;
    holidayKey: string;
    holidayDate: string;
    jurisdiction: string;
    actorId: string;
  },
): Promise<number> {
  const count = await evidencedEntitledPayDays(tx, {
    orgId: args.orgId,
    employeePartyId: args.employeePartyId,
    employeeName: args.employeeName,
    excludeDocumentId: args.documentId,
    jurisdiction: args.jurisdiction,
    holidayDate: args.holidayDate,
  });
  const changes = {
    event: "entitled_pay_days_complete",
    complete: true,
    employeePartyId: args.employeePartyId,
    holidayKey: args.holidayKey,
    holidayDate: args.holidayDate,
    evidencedDayCount: count,
  };
  await tx.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${args.orgId}, 'pay_run_holiday_assertions', ${args.documentId},
            'insert', ${JSON.stringify(changes)}::jsonb, ${args.actorId})`);
  return count;
}

export interface DemandingHoliday {
  key: string;
  date: string;
  name: string;
  jurisdiction: string;
  needsCommissionStatus: boolean;
  needsAbsenceAssertion: boolean;
  needsEntitlementDayAssessment: boolean;
  needsOccupationClass: boolean;
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
    country: string;
    province: string;
    labourJurisdiction: string | null;
    employeeName: string;
    periodStart: string;
    periodEnd: string;
  },
): Promise<DemandingHoliday[]> {
  const { orgId, country, province, labourJurisdiction, employeeName, periodStart, periodEnd } =
    args;
  const problem = labourJurisdictionProblem(country, labourJurisdiction);
  if (problem) {
    throw new PayrollError(
      `${employeeName} has a labour jurisdiction this payroll cannot honour — ${problem}`,
    );
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
  const holidays = resolveObservedHolidays({
    jurisdiction,
    from: periodStart,
    to: periodEnd,
    overrides,
  }).filter((holiday) => holiday.paid);
  const demanding: DemandingHoliday[] = [];
  for (const holiday of holidays) {
    const rule = statutoryHolidayPayRule(jurisdiction, holiday.date);
    if (!rule) continue;
    const basis = holidayPayLookbackBasis(rule.basis);
    const needsCommissionStatus = basis?.kind === "fixed_divisor" && basis.commission !== undefined;
    const needsAbsenceAssertion = rule.qualifying.lastAndFirstScheduledShift === true;
    const needsEntitlementDayAssessment =
      rule.qualifying.minDaysWorkedInWindow?.counting === "entitled_to_pay";
    const needsOccupationClass = ruleDeclaresOccupationArms(rule);
    if (
      needsCommissionStatus ||
      needsAbsenceAssertion ||
      needsEntitlementDayAssessment ||
      needsOccupationClass
    ) {
      demanding.push({
        key: holiday.key,
        date: holiday.date,
        name: holiday.name,
        jurisdiction,
        needsCommissionStatus,
        needsAbsenceAssertion,
        needsEntitlementDayAssessment,
        needsOccupationClass,
      });
    }
  }
  return demanding;
}
