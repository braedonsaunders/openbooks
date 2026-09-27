import "server-only";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { employeeRoles, projects, resAssignments } from "@openbooks/schema";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  buildResourcingForecast,
  type BenchPerson,
  type ForecastWindow,
  type ResourcingForecast,
  type RolloffPerson,
} from "@openbooks/engine/src/resourcing/forecast.ts";
import { readAvailability } from "@openbooks/engine/src/resourcing/availability-read.ts";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";

type AssignmentRow = typeof resAssignments.$inferSelect;

export type ResourcingBoardOptions = {
  firstSunday: string;
  lastSunday: string;
  projectId?: string;
  departmentId?: string;
  jobTitle?: string;
  rolloffWeeks?: number;
};

export type ResourcingBoard = {
  rows: AssignmentRow[];
  forecast: ResourcingForecast;
  /** Generic job-title bookings have no department and are omitted by that filter. */
  excludedGenericAssignmentCount: number;
};

const DEFAULT_ROLLOFF_WEEKS = 4;

export async function loadResourcingBoard(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: ResourcingBoardOptions,
): Promise<ResourcingBoard> {
  if (!(await isFeatureEnabled(orgId, "resourcing"))) {
    const { notFound } = await import("next/navigation");
    notFound();
  }

  const filters = [
    eq(resAssignments.orgId, orgId),
    eq(resAssignments.state, "active"),
    gte(resAssignments.weekStart, options.firstSunday),
    lte(resAssignments.weekStart, options.lastSunday),
  ];
  if (options.projectId) filters.push(eq(resAssignments.projectId, options.projectId));
  if (options.jobTitle) {
    filters.push(sql`(
      ${resAssignments.jobTitle} = ${options.jobTitle}
      or exists (
        select 1 from employee_roles er
         where er.org_id = ${resAssignments.orgId}
           and er.party_id = ${resAssignments.employeePartyId}
           and er.job_title = ${options.jobTitle}
      )
    )`);
  }
  const where = sql`${and(...filters)}${subsidiaryVisibleFilter(sql`projects.subsidiary_id`, allowedSubsidiaryIds)}`;

  const joined = await db.select({ assignment: resAssignments })
    .from(resAssignments)
    .innerJoin(projects, and(
      eq(projects.orgId, resAssignments.orgId),
      eq(projects.id, resAssignments.projectId),
    ))
    .where(where);
  const allRows = joined.map((row) => row.assignment);

  let rows = allRows;
  let excludedGenericAssignmentCount = 0;
  if (options.departmentId) {
    const genericRows = allRows.filter((row) => row.employeePartyId === null);
    excludedGenericAssignmentCount = genericRows.length;
    const employeeIds = [...new Set(allRows.flatMap((row) => row.employeePartyId ? [row.employeePartyId] : []))];
    const departmentPeople = employeeIds.length
      ? await db.select({ partyId: employeeRoles.partyId })
        .from(employeeRoles)
        .where(and(
          eq(employeeRoles.orgId, orgId),
          eq(employeeRoles.departmentId, options.departmentId),
          inArray(employeeRoles.partyId, employeeIds),
        ))
      : [];
    const visiblePeople = new Set(departmentPeople.map((row) => row.partyId));
    rows = allRows.filter((row) => row.employeePartyId !== null && visiblePeople.has(row.employeePartyId));
  }

  const employeeIds = [...new Set(rows.flatMap((row) => row.employeePartyId ? [row.employeePartyId] : []))];
  const availability = await readAvailability(
    orgId,
    employeeIds,
    options.firstSunday,
    options.lastSunday,
    allowedSubsidiaryIds,
  );
  const window: ForecastWindow = {
    firstWeek: options.firstSunday,
    lastWeek: options.lastSunday,
    asOf: await businessToday(orgId),
    rolloffWeeks: options.rolloffWeeks ?? DEFAULT_ROLLOFF_WEEKS,
  };
  return {
    rows,
    forecast: buildResourcingForecast(rows, availability, window),
    excludedGenericAssignmentCount,
  };
}

export async function loadBench(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: ResourcingBoardOptions,
): Promise<BenchPerson[]> {
  return (await loadResourcingBoard(orgId, allowedSubsidiaryIds, options)).forecast.bench;
}

export async function loadRolloffs(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: ResourcingBoardOptions,
): Promise<RolloffPerson[]> {
  return (await loadResourcingBoard(orgId, allowedSubsidiaryIds, options)).forecast.rolloffs;
}
