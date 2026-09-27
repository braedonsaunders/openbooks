import "server-only";
import { sql } from "drizzle-orm";
import { projectTasks, projects, resAssignments } from "@openbooks/schema";
import type { AvailabilityFigure } from "@openbooks/engine/src/resourcing/availability.ts";
import { readAvailability } from "@openbooks/engine/src/resourcing/availability-read.ts";
import { sum } from "@openbooks/engine/src/money/money.ts";
import { addCalendarDays } from "@openbooks/engine/src/platform/business-date.ts";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { subsidiaryVisibleFilter } from "../subsidiaries.ts";
import { loadFieldDefs } from "../custom-fields.ts";

type AssignmentRow = typeof resAssignments.$inferSelect;
type ActualTimeEntry = { id: string; workedOn: string; hours: string; memo: string | null };
type DrawerPerson = { id: string; name: string; jobTitle: string | null };
type DrawerItem = { id: string; name: string };
type DrawerTask = { id: string; name: string; projectId: string };
type DrawerAbsence = { id: string; onDate: string; hours: string };

export type AssignmentDrawerData = {
  assignment: AssignmentRow | null;
  createMode: boolean;
  prefill: {
    projectId: string;
    employeePartyId: string;
    jobTitle: string;
    weekStart: string;
    plannedHours: string;
  };
  projectLabel: string | null;
  people: DrawerPerson[];
  projects: DrawerItem[];
  items: DrawerItem[];
  tasks: DrawerTask[];
  capacity: AvailabilityFigure | null;
  actuals: { hours: string; entries: ActualTimeEntry[] };
  absenceRows: DrawerAbsence[];
  customDefs: Awaited<ReturnType<typeof loadFieldDefs>>;
};

/** Resolve a drawer entirely in the page loader, including its capacity and approved-time evidence. */
export async function loadAssignmentDrawerData(args: {
  orgId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  assignmentId: string | null;
  createMode?: boolean;
  prefill?: Partial<AssignmentDrawerData["prefill"]>;
}): Promise<AssignmentDrawerData | null> {
  const [projectRows, personRows, itemRows, customDefs] = await Promise.all([
    db.select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(sql`${projects.orgId} = ${args.orgId} and ${projects.isActive}${subsidiaryVisibleFilter(sql`projects.subsidiary_id`, args.allowedSubsidiaryIds)}`)
      .orderBy(projects.name, projects.id),
    db.execute<DrawerPerson>(sql`
      select p.id, p.display_name as name, er.job_title as "jobTitle"
        from parties p
        join employee_roles er on er.org_id = p.org_id and er.party_id = p.id and er.is_active
       where p.org_id = ${args.orgId} and p.kind = 'person' and p.is_active
         ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, args.allowedSubsidiaryIds)}
       order by p.display_name, p.id
    `),
    db.execute<DrawerItem>(sql`
      select id, name from items where org_id = ${args.orgId} and is_active order by name, id
    `),
    loadFieldDefs("res_assignments"),
  ]);

  let assignment: AssignmentRow | null = null;
  let projectLabel: string | null = null;
  if (args.assignmentId) {
    const found = await db.select({ assignment: resAssignments, projectName: projects.name })
      .from(resAssignments)
      .innerJoin(projects, sql`${projects.orgId} = ${resAssignments.orgId} and ${projects.id} = ${resAssignments.projectId}`)
      .where(sql`${resAssignments.orgId} = ${args.orgId} and ${resAssignments.id} = ${args.assignmentId}
        ${subsidiaryVisibleFilter(sql`projects.subsidiary_id`, args.allowedSubsidiaryIds)}`)
      .limit(1);
    assignment = found[0]?.assignment ?? null;
    projectLabel = found[0]?.projectName ?? null;
    if (!assignment) return null;
  }

  const prefill = {
    projectId: args.prefill?.projectId ?? assignment?.projectId ?? "",
    employeePartyId: args.prefill?.employeePartyId ?? assignment?.employeePartyId ?? "",
    jobTitle: args.prefill?.jobTitle ?? assignment?.jobTitle ?? "",
    weekStart: args.prefill?.weekStart ?? assignment?.weekStart ?? "",
    plannedHours: args.prefill?.plannedHours ?? assignment?.plannedHours ?? "8.0000",
  };
  const selectedProject = prefill.projectId && !projectRows.some((row) => row.id === prefill.projectId)
    ? await db.select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(sql`${projects.orgId} = ${args.orgId} and ${projects.id} = ${prefill.projectId}
        ${subsidiaryVisibleFilter(sql`projects.subsidiary_id`, args.allowedSubsidiaryIds)}`)
      .limit(1)
    : [];
  const selectedProjectRow = selectedProject[0];
  const projectsInScope = selectedProjectRow ? [selectedProjectRow, ...projectRows] : projectRows;
  if (!projectLabel) projectLabel = projectsInScope.find((row) => row.id === prefill.projectId)?.name ?? null;

  const selectedPerson = prefill.employeePartyId && !personRows.rows.some((row) => row.id === prefill.employeePartyId)
    ? await db.execute<DrawerPerson>(sql`
        select p.id, p.display_name as name, er.job_title as "jobTitle"
          from parties p join employee_roles er on er.org_id = p.org_id and er.party_id = p.id
         where p.org_id = ${args.orgId} and p.id = ${prefill.employeePartyId}
           ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, args.allowedSubsidiaryIds)}
         limit 1
      `)
    : { rows: [] as DrawerPerson[] };
  const people = selectedPerson.rows.length
    ? [selectedPerson.rows[0]!, ...personRows.rows]
    : personRows.rows;

  const tasks = await db.select({
    id: projectTasks.id,
    name: projectTasks.name,
    projectId: projectTasks.projectId,
  })
    .from(projectTasks)
    .innerJoin(projects, sql`${projects.orgId} = ${projectTasks.orgId} and ${projects.id} = ${projectTasks.projectId}`)
    .where(sql`${projectTasks.orgId} = ${args.orgId}${subsidiaryVisibleFilter(sql`projects.subsidiary_id`, args.allowedSubsidiaryIds)}`)
    .orderBy(projectTasks.name, projectTasks.id);

  let capacity: AvailabilityFigure | null = null;
  let actualEntries: ActualTimeEntry[] = [];
  let absenceRows: { id: string; onDate: string; hours: string }[] = [];
  if (prefill.employeePartyId && prefill.weekStart) {
    const [figures, entries, absences] = await Promise.all([
      readAvailability(args.orgId, [prefill.employeePartyId], prefill.weekStart, prefill.weekStart, args.allowedSubsidiaryIds),
      prefill.projectId
        ? db.execute<ActualTimeEntry>(sql`
            select id, worked_on::text as "workedOn", hours::text as hours, memo
              from time_entries
             where org_id = ${args.orgId} and employee_party_id = ${prefill.employeePartyId}
               and project_id = ${prefill.projectId} and status = 'approved'
               and worked_on >= ${prefill.weekStart}::date
               and worked_on <= ${addCalendarDays(prefill.weekStart, 6)}::date
             order by worked_on, id
          `)
        : Promise.resolve({ rows: [] as ActualTimeEntry[] }),
      db.execute<DrawerAbsence>(sql`
        select a.id, a.on_date::text as "onDate", a.hours::text as hours
          from hrm_absences a
          join worker_employments e on e.org_id = a.org_id and e.id = a.employment_id
         where a.org_id = ${args.orgId} and e.worker_party_id = ${prefill.employeePartyId}
           and a.on_date >= ${prefill.weekStart}::date
           and a.on_date <= ${addCalendarDays(prefill.weekStart, 6)}::date
         order by a.on_date, a.id
      `),
    ]);
    capacity = figures[0] ?? null;
    actualEntries = entries.rows;
    absenceRows = absences.rows;
  }

  return {
    assignment,
    createMode: args.createMode === true,
    prefill,
    projectLabel,
    people: people.map((person) => ({ ...person, name: person.name ?? "" })),
    projects: projectsInScope,
    items: itemRows.rows,
    tasks,
    capacity,
    actuals: { hours: sum(actualEntries.map((entry) => entry.hours)), entries: actualEntries },
    absenceRows,
    customDefs,
  };
}
