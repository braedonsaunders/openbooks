import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { PayrollError } from "./error.ts";
import type { StatutoryHolidayEligibilityFacts } from "./holidays.ts";

export interface HolidayFactsSource {
  profiles: {
    employee_party_id: string;
    paid_on_commission: boolean | null;
    statutory_occupation_class: string | null;
    updated_at: string;
  }[];
  assertions: {
    id: string;
    employee_party_id: string;
    holiday_key: string;
    holiday_date: string;
    absent_without_consent: boolean;
    updated_at: string;
    updated_by: string | null;
  }[];
  entitlementAssessments: {
    id: string;
    at: string;
    changes: Record<string, unknown>;
    actor_id: string | null;
  }[];
}

export interface StoredHolidayFacts {
  /** Employees with an ANSWERED standing commission status. */
  commissions: Map<string, boolean>;
  /** employee party id → (`holidayKey|holidayDate` → asserted value). */
  assertions: Map<string, Map<string, boolean>>;
  /** Latest audited complete-evidence count per employee and occurrence. */
  entitledDays: Map<string, Map<string, number>>;
  source: HolidayFactsSource;
}

/** Inner key for one holiday occurrence. Both halves are needed: one period
 *  can hold several paid holidays. */
export const holidayOccurrenceKey = (holidayKey: string, holidayDate: string): string =>
  `${holidayKey}|${holidayDate}`;

/**
 * Load this run's stored facts for its roster. Commission answers come from
 * the standing profile column (answered rows only — null stays unanswered);
 * absence assertions and audited entitlement-day assessments belong only to
 * this run (a later run cannot see an earlier run's answer).
 */
export async function loadStoredHolidayFacts(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string;
    documentId: string;
    employeePartyIds: readonly string[];
    lockSources?: boolean;
  },
): Promise<StoredHolidayFacts> {
  const { orgId, documentId, employeePartyIds } = args;
  const commissions = new Map<string, boolean>();
  const assertions = new Map<string, Map<string, boolean>>();
  const entitledDays = new Map<string, Map<string, number>>();
  const source: HolidayFactsSource = { profiles: [], assertions: [], entitlementAssessments: [] };
  if (employeePartyIds.length === 0) return { commissions, assertions, entitledDays, source };
  // Sequential reads: callers pass a transaction client for the run's
  // snapshot, which is one pg connection — fanning out queues concurrent
  // queries on it instead of running them together.
  const profileRows = await tx.execute<HolidayFactsSource["profiles"][number]>(
    sql`
      select employee_party_id, paid_on_commission, statutory_occupation_class,
             updated_at::text as updated_at
        from employee_payroll_profiles
       where org_id = ${orgId}
         and employee_party_id in (${sql.join(
           employeePartyIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
       order by employee_party_id ${args.lockSources ? sql`for share` : sql``}`,
    "objects",
  );
  const assertionRows = await tx.execute<HolidayFactsSource["assertions"][number]>(
    sql`
      select id, employee_party_id, holiday_key, holiday_date::text as holiday_date, absent_without_consent,
             updated_at::text as updated_at, updated_by
        from pay_run_holiday_assertions
       where org_id = ${orgId} and pay_run_document_id = ${documentId}
         and employee_party_id in (${sql.join(
           employeePartyIds.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
       order by employee_party_id, holiday_date, holiday_key ${args.lockSources ? sql`for share` : sql``}`,
    "objects",
  );
  const entitlementRows = await tx.execute<HolidayFactsSource["entitlementAssessments"][number]>(
    sql`
      select id, at::text as at, changes, actor_id from audit_log
       where org_id = ${orgId} and table_name = 'pay_run_holiday_assertions'
         and row_id = ${documentId} and action = 'insert'
         and changes->>'event' = 'entitled_pay_days_complete'
       order by at, id`,
    "objects",
  );
  for (const row of profileRows) {
    if (row.paid_on_commission !== null)
      commissions.set(row.employee_party_id, assertStoredBoolean(row.paid_on_commission));
  }
  for (const row of assertionRows) {
    const date = String(row.holiday_date).slice(0, 10);
    let perEmployee = assertions.get(row.employee_party_id);
    if (!perEmployee) {
      perEmployee = new Map<string, boolean>();
      assertions.set(row.employee_party_id, perEmployee);
    }
    perEmployee.set(holidayOccurrenceKey(row.holiday_key, date), row.absent_without_consent);
  }
  const roster = new Set(employeePartyIds);
  for (const row of entitlementRows) {
    const event = row.changes;
    const employeeId = event.employeePartyId;
    const holidayKey = event.holidayKey;
    const holidayDate = event.holidayDate;
    const count = event.evidencedDayCount;
    if (
      typeof employeeId !== "string" ||
      typeof holidayKey !== "string" ||
      typeof holidayDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(holidayDate) ||
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0 ||
      event.complete !== true ||
      row.actor_id === null
    ) {
      throw new PayrollError(
        "stored statutory holiday entitlement-day attestation is unreadable — refile it on the pay run",
      );
    }
    if (!roster.has(employeeId)) continue;
    let perEmployee = entitledDays.get(employeeId);
    if (!perEmployee) {
      perEmployee = new Map<string, number>();
      entitledDays.set(employeeId, perEmployee);
    }
    perEmployee.set(holidayOccurrenceKey(holidayKey, holidayDate), count);
    source.entitlementAssessments.push(row);
  }
  source.profiles = profileRows;
  source.assertions = assertionRows;
  return { commissions, assertions, entitledDays, source };
}

/** A non-null stored answer must be a boolean; unreadable facts refuse calculation. */
function assertStoredBoolean(value: boolean): boolean {
  if (typeof value !== "boolean") {
    throw new PayrollError(
      "stored commission-pay status is unreadable — re-answer it on the employee record",
    );
  }
  return value;
}

/** Project persisted facts without inventing employee-wide answers across holiday occurrences. */
export function holidayEligibilityFromStoredFacts(
  stored: Pick<StoredHolidayFacts, "commissions" | "assertions" | "entitledDays">,
): Record<string, StatutoryHolidayEligibilityFacts> {
  const facts: Record<string, StatutoryHolidayEligibilityFacts> = {};
  const employeeIds = new Set([
    ...stored.commissions.keys(),
    ...stored.assertions.keys(),
    ...stored.entitledDays.keys(),
  ]);
  for (const employeeId of employeeIds) {
    const commission = stored.commissions.get(employeeId);
    const assertions = stored.assertions.get(employeeId);
    const entitled = stored.entitledDays.get(employeeId);
    facts[employeeId] = {
      ...(commission !== undefined ? { paidOnCommission: commission } : {}),
      ...(assertions?.size
        ? { absentWithoutConsentByHoliday: Object.fromEntries(assertions) }
        : {}),
      ...(entitled?.size ? { entitledDayAttestations: Object.fromEntries(entitled) } : {}),
    };
  }
  return facts;
}

/** Current calculation evidence includes the identities and values of every stored holiday fact. */
export function isHolidayFactsSource(value: unknown): value is HolidayFactsSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Partial<HolidayFactsSource>;
  const timestamp = (value: unknown) =>
    typeof value === "string" && Number.isFinite(Date.parse(value));
  return (
    Array.isArray(source.profiles) &&
    source.profiles.every(
      (row) =>
        row &&
        isUuid(row.employee_party_id) &&
        (row.paid_on_commission === null || typeof row.paid_on_commission === "boolean") &&
        (row.statutory_occupation_class === null ||
          typeof row.statutory_occupation_class === "string") &&
        timestamp(row.updated_at),
    ) &&
    Array.isArray(source.assertions) &&
    source.assertions.every(
      (row) =>
        row &&
        isUuid(row.id) &&
        isUuid(row.employee_party_id) &&
        typeof row.holiday_key === "string" &&
        row.holiday_key.length > 0 &&
        isIsoCalendarDate(row.holiday_date) &&
        typeof row.absent_without_consent === "boolean" &&
        timestamp(row.updated_at) &&
        (row.updated_by === null || isUuid(row.updated_by)),
    ) &&
    Array.isArray(source.entitlementAssessments) &&
    source.entitlementAssessments.every(
      (row) =>
        row &&
        isUuid(row.id) &&
        timestamp(row.at) &&
        isUuid(row.actor_id) &&
        row.changes &&
        typeof row.changes === "object" &&
        row.changes.event === "entitled_pay_days_complete" &&
        row.changes.complete === true &&
        isUuid(row.changes.employeePartyId) &&
        typeof row.changes.holidayKey === "string" &&
        isIsoCalendarDate(row.changes.holidayDate) &&
        Number.isSafeInteger(row.changes.evidencedDayCount) &&
        Number(row.changes.evidencedDayCount) >= 0,
    )
  );
}
