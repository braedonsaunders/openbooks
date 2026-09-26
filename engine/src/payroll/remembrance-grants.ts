/**
 * Work-triggered alternate-day-off grants (I6-payroll-262).
 *
 * Nova Scotia's Remembrance Day Act earns an employee who works November 11
 * another day off WITH PAY instead of immediate cash. The grant is an
 * employee-specific `bank_in` movement in the alternate-day hours bank,
 * denominated in the employee's scheduled hours for November 11 and stamped
 * with its statutory source plus the take-on date — so payroll pays it when
 * the day is taken (through the plan's payout component) or at termination
 * (the final-pay sweep clears every bank), never on the November run itself.
 *
 * Shape mirrors the entitlement engine's split: `decideRemembranceGrant` is
 * PURE (unit-tested without a database) and `grantRemembranceAlternateDay`
 * is the thin adapter that loads rows and calls it.
 */
import { sql } from "drizzle-orm";
import { cmp } from "../money/money.ts";
import { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { countryOfJurisdiction } from "./pack-jurisdictions.ts";
import { PAYROLL_COUNTRY_PACKS } from "./pack-registry.ts";
import { resolveStoredEmployerFact } from "./employer-fact-store.ts";
import {
  PayrollHolidayError,
  countHolidayQualifyingDays,
  hoursOn,
  loadHolidayDayEvidence,
  shiftDays,
} from "./holidays.ts";
import type { EntitlementMovement } from "./entitlements-movement-kernel.ts";
import type { EntitlementPlan } from "./entitlements-types.ts";
import {
  adjacentScheduledDay,
  resolveWorkSchedule,
  scheduledHoursOn,
} from "./work-schedules.ts";

export interface RemembranceGrantArgs {
  employeeName: string;
  /** Approved hours worked on the statutory date; zero means untriggered. */
  workedHours: string;
  /** Days of the qualifying window the employee was entitled to wages for. */
  qualifyingDays: number;
  qualifyingRequired: number;
  /** Resolved business class, or null when the employer never recorded one. */
  businessClass: string | null;
  exemptBusinessClasses: readonly string[];
  /** Where the operator records the class — named in the refusal. */
  businessClassRemedy: string;
  /** The employee's scheduled hours for the statutory date, null when unknown. */
  scheduledHours: string | null;
  /** Next scheduled workday after the statutory date, null when there is none. */
  defaultTakeOn: string | null;
}

export type RemembranceGrantDecision =
  | { status: "grant"; hours: string; takeOn: string }
  | { status: "deny"; reason: string };

/**
 * The statute as a decision. Denials return (not worked, not qualified,
 * exempt business — each a different fact with a different appeal);
 * genuinely missing inputs THROW, naming the record that fixes them. A
 * missing input here is never scored as "not entitled": silence would erase
 * the benefit exactly the way omitting the date did.
 */
export function decideRemembranceGrant(args: RemembranceGrantArgs): RemembranceGrantDecision {
  const {
    employeeName, workedHours, qualifyingDays, qualifyingRequired,
    businessClass, exemptBusinessClasses, businessClassRemedy,
    scheduledHours, defaultTakeOn,
  } = args;
  if (cmp(workedHours, "0") <= 0) {
    return { status: "deny", reason: "did not work the statutory date" };
  }
  if (qualifyingDays < qualifyingRequired) {
    return {
      status: "deny",
      reason:
        `entitled to wages on ${qualifyingDays} of the qualifying days; ${qualifyingRequired} are required`,
    };
  }
  if (businessClass == null) {
    throw new PayrollHolidayError(
      `${employeeName} worked the statutory date and qualifies, but the employer's business class `
      + `is not recorded — an exempt business owes no alternate day and a covered one owes it, and `
      + `the run will not guess which this employer is. ${businessClassRemedy}`,
    );
  }
  if (exemptBusinessClasses.includes(businessClass)) {
    return { status: "deny", reason: `employed in an exempt business (${businessClass})` };
  }
  if (scheduledHours == null) {
    throw new PayrollHolidayError(
      `${employeeName} earned the alternate paid day, but no work schedule is in force on the `
      + "statutory date — the grant is denominated in the employee's scheduled hours for that day, "
      + "and this calculation will not assume a day length it has not been told about. Record the "
      + "hours and days they are normally scheduled to work, or record that their hours vary with "
      + "an agreed paid-day length",
    );
  }
  if (cmp(scheduledHours, "0") <= 0) {
    throw new PayrollHolidayError(
      `${employeeName} earned the alternate paid day by working a day they were not scheduled to `
      + "work, so there are no scheduled hours to denominate it in — granting zero hours would "
      + "erase the benefit. Record the paid-day length the employer agreed for the alternate day",
    );
  }
  if (defaultTakeOn == null) {
    throw new PayrollHolidayError(
      `${employeeName} earned the alternate paid day, but no scheduled workday follows the statutory `
      + "date to take it on — agree the take-on date with the employee and record it against the grant",
    );
  }
  return { status: "grant", hours: scheduledHours, takeOn: defaultTakeOn };
}

/**
 * Grant one employee's alternate day for the run's period, or null when the
 * statute does not trigger. Called beside the holiday-pay phase under the
 * same gate (statutory holiday pay ON, never on an off-cycle run).
 *
 * The grant is once per statutory source, not once per run: an overlapping
 * recalculation or a second run covering the date finds the earlier grant
 * (with any agreed take-on the operator recorded since) and stands off, so
 * the benefit can neither double nor lose its agreement on recompute.
 */
export async function grantRemembranceAlternateDay(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    runDocumentId: string;
    employeePartyId: string;
    employeeName: string;
    /** Resolved employee jurisdiction (labour-jurisdiction aware). */
    jurisdiction: string;
    /**
     * The run's legal entity — the employer the Act binds. Null when the run
     * is not assigned to one: the fact store then matches only org-wide rows,
     * so an unrecorded class still refuses by name rather than granting.
     */
    subsidiaryId: string | null;
    periodStart: string;
    periodEnd: string;
    /** The bound alternate-day bank; null when the org never provisioned one. */
    plan: EntitlementPlan | null;
  },
): Promise<EntitlementMovement | null> {
  const {
    orgId, runDocumentId, employeePartyId, employeeName,
    jurisdiction, subsidiaryId, periodStart, periodEnd, plan,
  } = args;
  // The pack declares the grant and the jurisdictions its statute binds;
  // the generic layer names no province.
  const rule = PAYROLL_COUNTRY_PACKS[countryOfJurisdiction(jurisdiction)]?.alternateDayGrant;
  if (!rule || !rule.jurisdictions.includes(jurisdiction)) return null;
  const statutoryDate = [periodStart.slice(0, 4), periodEnd.slice(0, 4)]
    .map((year) => `${year}-${String(rule.month).padStart(2, "0")}-${String(rule.day).padStart(2, "0")}`)
    .find((date) => date >= periodStart && date <= periodEnd) ?? null;
  if (!statutoryDate) return null;

  const workedHours = await hoursOn(tx, { orgId, employeePartyId }, statutoryDate);
  if (cmp(workedHours, "0") <= 0) return null;

  const qualifyingWindow = {
    from: shiftDays(statutoryDate, -rule.qualifyingWindowDays),
    to: shiftDays(statutoryDate, -1),
  };
  const schedule = await resolveWorkSchedule(tx, orgId, employeePartyId, statutoryDate);
  const evidence = await loadHolidayDayEvidence(
    tx, { orgId, employeePartyId, excludeDocumentId: runDocumentId },
    qualifyingWindow, [], true,
  );
  const qualifyingDays = countHolidayQualifyingDays({
    employee: employeeName, window: qualifyingWindow, counting: rule.counting, evidence, schedule,
  });
  if (qualifyingDays < rule.qualifyingDays) return null;

  const businessClass = await resolveStoredEmployerFact({
    tx, orgId, subsidiaryId, country: "CA",
    factKey: rule.businessClassFactKey, asOf: statutoryDate,
  });

  const decision = decideRemembranceGrant({
    employeeName,
    workedHours,
    qualifyingDays,
    qualifyingRequired: rule.qualifyingDays,
    businessClass,
    exemptBusinessClasses: rule.exemptBusinessClasses,
    businessClassRemedy:
      "Record the business class in Payroll setup → Employer facts, then recalculate.",
    scheduledHours: schedule ? scheduledHoursOn(schedule, statutoryDate) : null,
    defaultTakeOn: schedule ? adjacentScheduledDay(schedule, statutoryDate, 1) : null,
  });
  if (decision.status === "deny") return null;

  if (!plan) {
    throw new PayrollError(
      `${employeeName} earned the statutory alternate paid day, but this organization has no `
      + "alternate-day entitlement plan to grant it into — create one in Payroll setup → "
      + "Entitlement plans (hours, manual), then recalculate",
    );
  }
  const prior = (await tx.execute<{ id: string }>(sql`
    select id from entitlement_ledger
     where org_id = ${orgId} and plan_id = ${plan.id} and employee_party_id = ${employeePartyId}
       and kind = 'bank_in'
       and source_holiday_key = ${rule.holidayKey} and source_holiday_date = ${statutoryDate}
     limit 1
  `)).rows[0];
  if (prior) return null;

  return {
    planId: plan.id,
    employeePartyId,
    movementDate: statutoryDate,
    amount: decision.hours,
    hours: decision.hours,
    kind: "bank_in",
    // Deliberately no component: the grant pays nothing now, so it lands on
    // no stub line. The payout component prices it when the day is taken.
    componentId: null,
    note:
      `Statutory alternate paid day (${rule.citation}): worked ${statutoryDate}, `
      + `take on ${decision.takeOn}`,
    sourceHolidayKey: rule.holidayKey,
    sourceHolidayDate: statutoryDate,
    takeOn: decision.takeOn,
  };
}

/**
 * The audited agreed-date override: the employer and employee agree a
 * different take-on day than the next-workday default, and the agreement is
 * recorded against the grant with a reason — never by editing history
 * elsewhere. Recalculations stand off the existing grant (see above), so the
 * agreement survives recompute.
 */
export async function recordAlternateDayAgreement(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    actorId: string;
    planId: string;
    employeePartyId: string;
    employeeName: string;
    sourceHolidayKey: string;
    sourceHolidayDate: string;
    agreedDate: string;
    reason: unknown;
  },
): Promise<void> {
  const reasonText = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reasonText || reasonText.length > 500) {
    throw new PayrollError("agreeing an alternate take-on date needs a reason (up to 500 characters)");
  }
  if (args.agreedDate < args.sourceHolidayDate) {
    throw new PayrollError(
      `the agreed take-on date ${args.agreedDate} is before the holiday ${args.sourceHolidayDate} `
      + "that earned it — the alternate day is always taken after",
    );
  }
  const updated = await tx.execute(sql`
    update entitlement_ledger
       set take_on = ${args.agreedDate},
           note = coalesce(note || ' | ', '')
             || ${`Agreed take-on ${args.agreedDate}: ${reasonText}`},
           updated_by = ${args.actorId}, updated_at = now()
     where org_id = ${args.orgId} and plan_id = ${args.planId}
       and employee_party_id = ${args.employeePartyId} and kind = 'bank_in'
       and source_holiday_key = ${args.sourceHolidayKey}
       and source_holiday_date = ${args.sourceHolidayDate}
  `);
  // A write that matches zero rows is a failure, not a success: no grant
  // means there is nothing to agree a date on, and reporting one would leave
  // an agreement no read can observe.
  if ((updated.rowCount ?? 0) !== 1) {
    throw new PayrollError(
      `${args.employeeName} has no alternate-day grant for ${args.sourceHolidayDate} to agree `
      + "a take-on date on — the grant is recorded when the run covering the holiday calculates",
    );
  }
}
