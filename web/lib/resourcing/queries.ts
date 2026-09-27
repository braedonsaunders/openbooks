import "server-only";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { employeeRoles, parties, projects, resAssignments } from "@openbooks/schema";
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
import { assertSundayWindow } from "@openbooks/engine/src/resourcing/weeks.ts";
import { ResourcingRefusal } from "@openbooks/engine/src/resourcing/errors.ts";
import {
  projectDerivedStatus,
  type StoredQualificationStatus,
} from "@openbooks/engine/src/hrm/qualifications/shared.ts";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";

type AssignmentRow = typeof resAssignments.$inferSelect;
type QualificationRow = {
  party_id: string;
  status: StoredQualificationStatus;
  issued_on: string;
  expires_on: string | null;
  renewal_lead_days: number;
};

export type ResourcingBoardOptions = {
  firstSunday: string;
  lastSunday: string;
  projectId?: string;
  departmentId?: string;
  jobTitle?: string;
  qualificationTypeId?: string;
  onDate?: string;
  page?: number;
  rolloffWeeks?: number;
};

export type StaffablePerson = {
  partyId: string;
  displayName: string;
  jobTitle: string | null;
  departmentId: string | null;
};

export type StaffablePeoplePage = {
  people: StaffablePerson[];
  total: number;
};

export type ResourcingBoard = {
  rows: AssignmentRow[];
  forecast: ResourcingForecast;
  /** Generic job-title bookings have no department and are omitted by that filter. */
  excludedGenericAssignmentCount: number;
  people: StaffablePerson[];
  total: number;
  page: number;
  pageSize: number;
};

const DEFAULT_ROLLOFF_WEEKS = 4;
const MAX_BOARD_PEOPLE = 50;
const MAX_BOARD_PERSON_WEEKS = 520;

/** Read active, in-scope employees before loading the bounded availability window. */
export async function loadStaffablePeople(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: {
    departmentId?: string;
    jobTitle?: string;
    qualificationTypeId?: string;
    onDate: string;
    page: number;
    pageSize: number;
  },
): Promise<StaffablePeoplePage> {
  const filters = [
    eq(parties.orgId, orgId),
    eq(parties.kind, "person"),
    eq(parties.isActive, true),
    eq(employeeRoles.isActive, true),
  ];
  if (options.departmentId) filters.push(eq(employeeRoles.departmentId, options.departmentId));
  if (options.jobTitle) filters.push(eq(employeeRoles.jobTitle, options.jobTitle));

  const certificationsOn = options.qualificationTypeId
    ? await isFeatureEnabled(orgId, "hrmCertifications")
    : false;
  if (certificationsOn && options.qualificationTypeId) {
    const qualifications = (await db.execute<QualificationRow>(sql`
      select e.worker_party_id as party_id, q.status, q.issued_on::text as issued_on,
             q.expires_on::text as expires_on, t.renewal_lead_days
        from hrm_worker_qualifications q
        join worker_employments e on e.org_id = q.org_id and e.id = q.employment_id
        join hrm_qualification_types t on t.org_id = q.org_id and t.id = q.type_id
       where q.org_id = ${orgId} and q.type_id = ${options.qualificationTypeId}
         and t.is_active
    `)).rows;
    const qualifiedPeople = new Set<string>();
    for (const row of qualifications) {
      const status = projectDerivedStatus({
        stored: row.status,
        expiresOn: row.expires_on,
        leadDays: row.renewal_lead_days,
        today: options.onDate,
        issuedOn: row.issued_on,
      });
      if (status === "valid" || status === "expiring") qualifiedPeople.add(row.party_id);
    }
    filters.push(qualifiedPeople.size > 0
      ? inArray(parties.id, [...qualifiedPeople])
      : sql`false`);
  }

  const where = sql`${and(...filters)}${subsidiaryVisibleFilter(sql`parties.subsidiary_id`, allowedSubsidiaryIds)}`;
  const total = (await db.select({ total: sql<number>`count(*)::int` })
    .from(parties)
    .innerJoin(employeeRoles, and(
      eq(employeeRoles.orgId, parties.orgId),
      eq(employeeRoles.partyId, parties.id),
    ))
    .where(where))[0]?.total ?? 0;
  const requestedPage = Math.max(1, Math.floor(options.page));
  const pageSize = Math.max(1, Math.min(MAX_BOARD_PEOPLE, Math.floor(options.pageSize)));
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(pageCount, requestedPage);
  const people = await db.select({
    partyId: parties.id,
    displayName: parties.displayName,
    jobTitle: employeeRoles.jobTitle,
    departmentId: employeeRoles.departmentId,
  })
    .from(parties)
    .innerJoin(employeeRoles, and(
      eq(employeeRoles.orgId, parties.orgId),
      eq(employeeRoles.partyId, parties.id),
    ))
    .where(where)
    .orderBy(parties.displayName, parties.id)
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return {
    people: people.map((person) => ({ ...person, displayName: person.displayName ?? "" })),
    total,
  };
}

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

  const weekCount = assertSundayWindow(options.firstSunday, options.lastSunday);
  if (weekCount > MAX_BOARD_PERSON_WEEKS) {
    throw new ResourcingRefusal(
      422,
      "board_window_too_large",
      "the staffing board window exceeds the 520-week limit",
      "request 520 weeks or fewer",
    );
  }
  const pageSize = Math.min(MAX_BOARD_PEOPLE, Math.floor(MAX_BOARD_PERSON_WEEKS / weekCount));
  const requestedPage = Math.max(1, Math.floor(options.page ?? 1));
  const staff = await loadStaffablePeople(orgId, allowedSubsidiaryIds, {
    departmentId: options.departmentId,
    jobTitle: options.jobTitle,
    qualificationTypeId: options.qualificationTypeId,
    onDate: options.onDate ?? await businessToday(orgId),
    page: requestedPage,
    pageSize,
  });
  const page = Math.min(Math.max(1, Math.ceil(staff.total / pageSize)), requestedPage);
  const pageEmployeeIds = staff.people.map((person) => person.partyId);
  const pageFilter = pageEmployeeIds.length > 0
    ? sql`(${inArray(resAssignments.employeePartyId, pageEmployeeIds)} or ${resAssignments.employeePartyId} is null)`
    : sql`${resAssignments.employeePartyId} is null`;
  const joined = await db.select({ assignment: resAssignments })
    .from(resAssignments)
    .innerJoin(projects, and(
      eq(projects.orgId, resAssignments.orgId),
      eq(projects.id, resAssignments.projectId),
    ))
    .where(sql`${where} and ${pageFilter}`);
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

  const employeeIds = pageEmployeeIds;
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
    people: staff.people,
    total: staff.total,
    page,
    pageSize,
  };
}

export async function loadBench(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: ResourcingBoardOptions,
): Promise<BenchPerson[]> {
  const pages = await loadAllBoardPages(orgId, allowedSubsidiaryIds, options);
  return pages.flatMap((page) => page.forecast.bench);
}

export async function loadRolloffs(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: ResourcingBoardOptions,
): Promise<RolloffPerson[]> {
  const pages = await loadAllBoardPages(orgId, allowedSubsidiaryIds, options);
  return pages.flatMap((page) => page.forecast.rolloffs);
}

async function loadAllBoardPages(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  options: ResourcingBoardOptions,
): Promise<ResourcingBoard[]> {
  const first = await loadResourcingBoard(orgId, allowedSubsidiaryIds, { ...options, page: 1 });
  const pageCount = Math.ceil(first.total / first.pageSize);
  const pages = [first];
  for (let page = 2; page <= pageCount; page += 1) {
    pages.push(await loadResourcingBoard(orgId, allowedSubsidiaryIds, { ...options, page }));
  }
  return pages;
}
