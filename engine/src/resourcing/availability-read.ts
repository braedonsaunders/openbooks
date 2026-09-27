import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { addCalendarDays } from "../platform/business-date.ts";
import { laborCostingSettings } from "../projects/labor-costing.ts";
import { PayrollError } from "../payroll/error.ts";
import {
  loadHolidayOverrides,
  resolveObservedHolidays,
  type ObservedHoliday,
} from "../payroll/holidays.ts";
import { jurisdictionKey, payrollJurisdictionDeclared } from "../payroll/pack-jurisdictions.ts";
import { resolveEmployeeJurisdiction } from "../payroll/run-stub-records.ts";
import { loadWorkSchedules } from "../payroll/work-schedules.ts";
import { ResourcingRefusal } from "./errors.ts";
import {
  computeAvailabilityForWeek,
  type AvailabilityAbsence,
  type AvailabilityFigure,
} from "./availability.ts";
import { assertSundayWindow, weeksBetween } from "./weeks.ts";

interface EmployeeAvailabilityScope {
  partyId: string;
  displayName: string;
  jobTitle: string | null;
  tradeId: string | null;
  departmentId: string | null;
  subsidiaryId: string | null;
  subsidiaryCountry: string | null;
  profileCountry: string | null;
  profileProvince: string | null;
  labourJurisdiction: string | null;
}

interface AbsenceRow extends AvailabilityAbsence {
  employeePartyId: string;
}

function list(values: readonly string[]) {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

function scopePredicate(allowedSubsidiaryIds: ReadonlySet<string> | null) {
  if (allowedSubsidiaryIds === null) return sql``;
  if (allowedSubsidiaryIds.size === 0) return sql`and false`;
  return sql`and p.subsidiary_id in (${list([...allowedSubsidiaryIds])})`;
}

function resolveHolidayJurisdiction(employee: EmployeeAvailabilityScope): {
  jurisdiction: string | null;
  reason?: string;
} {
  let jurisdiction: string | null = null;
  if (employee.profileCountry !== null && employee.profileProvince !== null) {
    try {
      jurisdiction = resolveEmployeeJurisdiction({
        country: employee.profileCountry,
        province: employee.profileProvince,
        emp: { labour_jurisdiction: employee.labourJurisdiction },
        employeeName: employee.displayName || employee.partyId,
      });
    } catch (error) {
      if (!(error instanceof PayrollError)) throw error;
      return { jurisdiction: null, reason: error.message };
    }
  } else if (employee.subsidiaryCountry) {
    jurisdiction = jurisdictionKey(employee.subsidiaryCountry, null);
  } else {
    return {
      jurisdiction: null,
      reason: "No payroll profile or subsidiary country identifies a holiday jurisdiction.",
    };
  }

  if (!payrollJurisdictionDeclared(jurisdiction)) {
    return {
      jurisdiction: null,
      reason: `No payroll holiday calendar is declared for jurisdiction ${jurisdiction}.`,
    };
  }
  return { jurisdiction };
}

/**
 * Read weekly capacity for a bounded set of employees. Schedules, employee
 * scope, employment leave, and holiday calendars are loaded in batches so a
 * person-week request does not trigger per-person database reads.
 */
export async function readAvailability(
  orgId: string,
  partyIds: readonly string[],
  firstSunday: string,
  lastSunday: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<AvailabilityFigure[]> {
  const weekCount = assertSundayWindow(firstSunday, lastSunday);
  const employeeIds = [...new Set(partyIds)];
  const personWeeks = employeeIds.length * weekCount;
  if (personWeeks > 520) {
    throw new ResourcingRefusal(
      422,
      "availability_query_too_large",
      `availability request covers ${personWeeks} person-weeks; the limit is 520 per call`,
      "request fewer people or a shorter date range",
    );
  }
  if (employeeIds.length === 0 || allowedSubsidiaryIds?.size === 0) return [];

  const weekStarts = weeksBetween(firstSunday, lastSunday);
  const lastSaturday = addCalendarDays(lastSunday, 6);
  const requestedIds = list(employeeIds);
  const employeeRows = (await db.execute<{
    party_id: string;
    display_name: string;
    job_title: string | null;
    trade_id: string | null;
    department_id: string | null;
    subsidiary_id: string | null;
    subsidiary_country: string | null;
    profile_country: string | null;
    profile_province: string | null;
    labour_jurisdiction: string | null;
  }>(sql`
    select p.id as party_id, p.display_name,
           er.job_title, er.trade_id, er.department_id, p.subsidiary_id,
           s.country as subsidiary_country,
           prof.country as profile_country, prof.province as profile_province,
           prof.labour_jurisdiction
      from parties p
      left join employee_roles er on er.org_id = p.org_id and er.party_id = p.id
      left join subsidiaries s on s.org_id = p.org_id and s.id = p.subsidiary_id
      left join employee_payroll_profiles prof
        on prof.org_id = p.org_id and prof.employee_party_id = p.id
     where p.org_id = ${orgId}
       and p.id in (${requestedIds})
       ${scopePredicate(allowedSubsidiaryIds)}
     order by p.id
  `)).rows;
  if (employeeRows.length === 0) return [];

  const employees: EmployeeAvailabilityScope[] = employeeRows.map((row) => ({
    partyId: row.party_id,
    displayName: row.display_name,
    jobTitle: row.job_title,
    tradeId: row.trade_id,
    departmentId: row.department_id,
    subsidiaryId: row.subsidiary_id,
    subsidiaryCountry: row.subsidiary_country,
    profileCountry: row.profile_country,
    profileProvince: row.profile_province,
    labourJurisdiction: row.labour_jurisdiction,
  }));
  const visibleEmployeeIds = employees.map((employee) => employee.partyId);
  const ids = list(visibleEmployeeIds);
  const schedules = await loadWorkSchedules(db, orgId, allowedSubsidiaryIds);
  const settings = await laborCostingSettings(orgId);
  const absenceRows = (await db.execute<{
    id: string;
    employee_party_id: string;
    on_date: string;
    hours: string;
  }>(sql`
    select a.id, e.worker_party_id as employee_party_id,
           a.on_date::text as on_date, a.hours::text as hours
      from hrm_absences a
      join worker_employments e on e.org_id = a.org_id and e.id = a.employment_id
     where a.org_id = ${orgId}
       and e.worker_party_id in (${ids})
       and a.on_date >= ${firstSunday} and a.on_date <= ${lastSaturday}
     order by e.worker_party_id, a.on_date, a.id
  `)).rows.map((row) => ({
    id: row.id,
    employeePartyId: row.employee_party_id,
    onDate: row.on_date,
    hours: row.hours,
  } satisfies AbsenceRow));

  const jurisdictionByEmployee = new Map<string, { jurisdiction: string | null; reason?: string }>();
  const jurisdictionSet = new Set<string>();
  for (const employee of employees) {
    const result = resolveHolidayJurisdiction(employee);
    jurisdictionByEmployee.set(employee.partyId, result);
    if (result.jurisdiction) jurisdictionSet.add(result.jurisdiction);
  }

  const holidaysByJurisdiction = new Map<string, ObservedHoliday[]>();
  for (const jurisdiction of jurisdictionSet) {
    const overrides = await loadHolidayOverrides(db, orgId, jurisdiction);
    holidaysByJurisdiction.set(jurisdiction, resolveObservedHolidays({
      jurisdiction,
      from: firstSunday,
      to: lastSaturday,
      overrides,
    }));
  }

  const absenceByEmployee = new Map<string, AbsenceRow[]>();
  for (const absence of absenceRows) {
    const group = absenceByEmployee.get(absence.employeePartyId) ?? [];
    group.push(absence);
    absenceByEmployee.set(absence.employeePartyId, group);
  }

  const output: AvailabilityFigure[] = [];
  for (const employee of employees) {
    const holidayResult = jurisdictionByEmployee.get(employee.partyId)!;
    const holidayInput = holidayResult.jurisdiction
      ? {
        applied: true,
        jurisdiction: holidayResult.jurisdiction,
        dates: holidaysByJurisdiction.get(holidayResult.jurisdiction) ?? [],
      }
      : {
        applied: false,
        jurisdiction: null,
        reason: holidayResult.reason ?? "Holiday jurisdiction could not be resolved.",
        dates: [],
      };
    const employeeAbsences = absenceByEmployee.get(employee.partyId) ?? [];
    for (const weekStart of weekStarts) {
      output.push(computeAvailabilityForWeek({
        employeePartyId: employee.partyId,
        weekStart,
        scheduleScope: {
          jobTitle: employee.jobTitle,
          tradeId: employee.tradeId,
          departmentId: employee.departmentId,
          subsidiaryId: employee.subsidiaryId,
        },
        schedules,
        annualHours: settings.annualHours,
        holidays: holidayInput,
        absences: employeeAbsences,
      }));
    }
  }
  return output;
}
