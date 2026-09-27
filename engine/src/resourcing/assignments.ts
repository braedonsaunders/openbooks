import { sql } from "drizzle-orm";
import {
  RES_ASSIGNMENT_BOOKING_VALUES,
  RES_ASSIGNMENT_SOURCE_VALUES,
  resAssignments,
} from "@openbooks/schema";
import { addCalendarDays } from "../platform/business-date.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { decimalNullRefusal } from "../money/decimal-refusal.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { add, cmp, neg, sum } from "../money/money.ts";
import { assertPlannableCapacity, type AvailabilityFigure } from "./availability.ts";
import { ResourcingRefusal } from "./errors.ts";
import { lockProjectForScope } from "../organization/subsidiary-scope.ts";
import { weekStartOf } from "./weeks.ts";
import { readAvailability } from "./availability-read.ts";
import { lockAndRequireResourcing } from "./feature.ts";

type AssignmentRow = typeof resAssignments.$inferSelect;
type Booking = (typeof RES_ASSIGNMENT_BOOKING_VALUES)[number];
type Source = (typeof RES_ASSIGNMENT_SOURCE_VALUES)[number];

interface AssignmentWriteContext {
  orgId: string;
  actorId: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

type AssignmentSubject =
  | { employeePartyId: string; jobTitle?: never }
  | { employeePartyId?: never; jobTitle: string };

export type UpsertAssignmentInput = AssignmentWriteContext & AssignmentSubject & {
  projectId: string;
  weekStart: string;
  plannedHours: unknown;
  isBillable?: boolean;
  billItemId?: string | null;
  projectTaskId?: string | null;
  booking?: Booking;
  source?: Source;
  requestId?: string | null;
  custom?: Record<string, unknown>;
};

export interface AssignmentWeeklyTotals {
  subject: { employeePartyId: string } | { jobTitle: string };
  weekStart: string;
  hardHours: string;
  softHours: string;
  totalHours: string;
  netCapacity: string | null;
  availableHours: string | null;
  overallocated: boolean | null;
}

export interface AssignmentWriteResult {
  assignment: AssignmentRow;
  weeklyTotals: AssignmentWeeklyTotals | null;
}

const ASSIGNMENT_COLUMNS = sql`
  id, org_id as "orgId", project_id as "projectId",
  employee_party_id as "employeePartyId", job_title as "jobTitle",
  week_start::text as "weekStart", planned_hours::text as "plannedHours",
  is_billable as "isBillable", bill_item_id as "billItemId",
  project_task_id as "projectTaskId", booking, state, source,
  request_id as "requestId", custom, created_at as "createdAt",
  created_by as "createdBy", updated_at as "updatedAt", updated_by as "updatedBy"
`;

async function inAssignmentWrite<T>(
  context: AssignmentWriteContext,
  work: (tx: SqlExecutor) => Promise<T>,
): Promise<T> {
  return withOrgTransaction(context.orgId, () => db.transaction(async (tx) => {
    await lockAndRequireResourcing(tx, context.orgId);
    return work(tx);
  }));
}

function refuse(
  code: string,
  message: string,
  remedy: string,
  field?: string,
  status: 409 | 422 = 422,
): never {
  throw new ResourcingRefusal(status, code, message, remedy, field);
}

function assertSunday(weekStart: string): void {
  try {
    if (weekStartOf(weekStart) === weekStart) return;
  } catch {
    // Invalid civil dates are operator input errors at this boundary.
  }
  refuse(
    "assignment_week_must_start_sunday",
    `${weekStart} is not a valid Sunday assignment week`,
    "choose the Sunday that starts the timesheet week",
    "weekStart",
  );
}

function readPlannedHours(raw: unknown): string {
  const exact = canonicalDecimal(raw, 4);
  if (exact === null) {
    refuse(
      "invalid_assignment_hours",
      decimalNullRefusal("plannedHours", "a number of hours", raw, 4),
      "enter the hours as a decimal string using a period for decimals",
      "plannedHours",
    );
  }
  if (cmp(exact, "0") <= 0 || cmp(exact, "168") > 0) {
    refuse(
      "assignment_hours_out_of_range",
      "planned hours must be greater than zero and no more than 168 for one week",
      "enter a positive number of hours no greater than 168",
      "plannedHours",
    );
  }
  return exact;
}

async function assertOpenProject(
  tx: SqlExecutor,
  input: AssignmentWriteContext & { projectId: string },
): Promise<void> {
  await lockProjectForScope(tx, input.orgId, input.projectId, input.allowedSubsidiaryIds, "share");
  const project = (await tx.execute<{ status: string }>(sql`
    select status from projects where org_id = ${input.orgId} and id = ${input.projectId}
  `)).rows[0];
  if (!project) throw new Error("a project disappeared while its scope lock was held");
  if (project.status === "closed" || project.status === "cancelled") {
    refuse(
      "project_not_active",
      `project ${input.projectId} is ${project.status} and cannot receive assignments`,
      "reopen the project (its status is editable on the project) or choose an active project",
      "projectId",
    );
  }
}

async function assertValidSubject(
  tx: SqlExecutor,
  input: UpsertAssignmentInput,
): Promise<AvailabilityFigure | null> {
  if (input.employeePartyId) {
    const figures = await readAvailability(
      input.orgId,
      [input.employeePartyId],
      input.weekStart,
      input.weekStart,
      input.allowedSubsidiaryIds,
    );
    const figure = figures.find((candidate) => candidate.employeePartyId === input.employeePartyId);
    if (!figure) {
      refuse(
        "assignment_employee_unavailable",
        `employee ${input.employeePartyId} is unknown or outside the permitted subsidiary scope`,
        "choose an employee whose capacity is visible in your subsidiary scope",
        "employeePartyId",
      );
    }
    assertPlannableCapacity(figure);
    return figure;
  }

  const jobTitle = input.jobTitle?.trim() ?? "";
  if (jobTitle.length === 0) {
    refuse(
      "assignment_job_title_unknown",
      "a generic assignment needs an existing job title",
      "use an existing job title or add it to an employee's role",
      "jobTitle",
    );
  }
  const title = (await tx.execute<{ job_title: string }>(sql`
    select job_title from employee_roles
     where org_id = ${input.orgId} and job_title is not null
       and lower(btrim(job_title)) = lower(${jobTitle})
    union all
    select job_title from work_schedules
     where org_id = ${input.orgId} and job_title is not null
       and lower(btrim(job_title)) = lower(${jobTitle})
    union all
    select job_title from labor_cost_rates
     where org_id = ${input.orgId} and job_title is not null
       and lower(btrim(job_title)) = lower(${jobTitle})
    limit 1
  `)).rows[0];
  if (!title) {
    refuse(
      "assignment_job_title_unknown",
      `job title ${jobTitle} is not used by an employee role, work schedule, or labor-cost rate`,
      "use an existing job title or add it to an employee's role",
      "jobTitle",
    );
  }
  return null;
}

async function assertReferences(
  tx: SqlExecutor,
  input: UpsertAssignmentInput & { projectId: string; source: Source },
): Promise<void> {
  if (input.billItemId) {
    const item = (await tx.execute<{ id: string }>(sql`
      select id from items where org_id = ${input.orgId} and id = ${input.billItemId}
    `)).rows[0];
    if (!item) {
      refuse(
        "assignment_bill_item_unknown",
        `bill item ${input.billItemId} does not belong to this organization`,
        "choose a service item from this organization or clear the bill item",
        "billItemId",
      );
    }
  }
  if (input.projectTaskId) {
    const task = (await tx.execute<{ id: string }>(sql`
      select task.id from project_tasks task
      join projects project on project.org_id = task.org_id and project.id = task.project_id
      where task.org_id = ${input.orgId} and task.id = ${input.projectTaskId}
        and task.project_id = ${input.projectId} and project.org_id = ${input.orgId}
    `)).rows[0];
    if (!task) {
      refuse(
        "assignment_project_task_unknown",
        `project task ${input.projectTaskId} does not belong to project ${input.projectId}`,
        "choose a task from the selected project or clear the project task",
        "projectTaskId",
      );
    }
  }

  if (input.source === "request") {
    if (!input.requestId) {
      refuse(
        "assignment_request_required",
        "an assignment sourced from a request must identify that request",
        "choose the resource request that created this assignment",
        "requestId",
      );
    }
    const request = (await tx.execute<{ id: string }>(sql`
      select id from res_requests
       where org_id = ${input.orgId} and id = ${input.requestId}
         and project_id = ${input.projectId}
    `)).rows[0];
    if (!request) {
      refuse(
        "assignment_request_unknown",
        `resource request ${input.requestId} does not belong to project ${input.projectId}`,
        "choose a request from the selected project",
        "requestId",
      );
    }
  } else if (input.requestId) {
    refuse(
      "assignment_request_source_mismatch",
      "only assignments sourced from a request can link to a resource request",
      "set the source to request or clear the request link",
      "requestId",
    );
  }
}

export interface ValidatedAssignmentPlan {
  plannedHours: string;
  jobTitle: string | null;
  figure: AvailabilityFigure | null;
  booking: Booking;
  source: Source;
}

/** Reuse the assignment writer's validation for draft resource requests. */
export async function validateAssignmentPlan(
  tx: SqlExecutor,
  input: UpsertAssignmentInput,
): Promise<ValidatedAssignmentPlan> {
  assertSunday(input.weekStart);
  const plannedHours = readPlannedHours(input.plannedHours);
  const hasEmployee = Boolean(input.employeePartyId?.trim());
  const hasJobTitle = Boolean(input.jobTitle?.trim());
  if (hasEmployee === hasJobTitle) {
    refuse(
      "assignment_subject_invalid",
      "an assignment must identify exactly one employee or generic job title",
      "choose one employee or use one existing job title",
      "employeePartyId",
    );
  }
  if (input.employeePartyId && input.employeePartyId !== input.employeePartyId.trim()) {
    refuse(
      "assignment_employee_invalid",
      "employee id contains surrounding whitespace",
      "choose the employee from the organization list",
      "employeePartyId",
    );
  }
  const booking = input.booking ?? "hard";
  const source = input.source ?? "manual";
  if (!RES_ASSIGNMENT_BOOKING_VALUES.includes(booking)) {
    refuse("assignment_booking_invalid", `booking value ${booking} is not supported`, "choose soft or hard", "booking");
  }
  if (!RES_ASSIGNMENT_SOURCE_VALUES.includes(source)) {
    refuse("assignment_source_invalid", `source value ${source} is not supported`, "choose manual, request, or pipeline", "source");
  }
  const prepared = { ...input, booking, source };
  await assertOpenProject(tx, input);
  const figure = await assertValidSubject(tx, prepared);
  await assertReferences(tx, prepared);
  return {
    plannedHours,
    jobTitle: input.jobTitle?.trim() ?? null,
    figure,
    booking,
    source,
  };
}

async function readWeeklyTotals(
  tx: SqlExecutor,
  input: AssignmentWriteContext & AssignmentSubject & { weekStart: string },
  netCapacity: string | null,
): Promise<AssignmentWeeklyTotals> {
  const subjectFilter = input.employeePartyId
    ? sql`employee_party_id = ${input.employeePartyId}`
    : sql`lower(job_title) = lower(${input.jobTitle!.trim()})`;
  const rows = (await tx.execute<{ booking: Booking; planned_hours: string }>(sql`
    select booking, planned_hours::text as planned_hours from res_assignments
     where org_id = ${input.orgId} and week_start = ${input.weekStart}
       and state = 'active' and ${subjectFilter}
  `)).rows;
  const hardHours = sum(rows.filter((row) => row.booking === "hard").map((row) => row.planned_hours));
  const softHours = sum(rows.filter((row) => row.booking === "soft").map((row) => row.planned_hours));
  return {
    subject: input.employeePartyId
      ? { employeePartyId: input.employeePartyId }
      : { jobTitle: input.jobTitle!.trim() },
    weekStart: input.weekStart,
    hardHours,
    softHours,
    totalHours: add(hardHours, softHours),
    netCapacity,
    availableHours: netCapacity === null ? null : add(netCapacity, neg(hardHours)),
    overallocated: netCapacity === null ? null : cmp(hardHours, netCapacity) > 0,
  };
}

/** Create or update one project-week/person-or-role assignment. */
export async function upsertAssignment(input: UpsertAssignmentInput): Promise<AssignmentWriteResult> {
  return inAssignmentWrite(input, async (tx) => {
    const validated = await validateAssignmentPlan(tx, input);
    const rowResult = await tx.execute<AssignmentRow>(sql`
      insert into res_assignments (
        org_id, project_id, employee_party_id, job_title, week_start, planned_hours,
        is_billable, bill_item_id, project_task_id, booking, state, source, request_id,
        custom, created_by, updated_by
      ) values (
        ${input.orgId}, ${input.projectId}, ${input.employeePartyId ?? null}, ${validated.jobTitle},
        ${input.weekStart}, ${validated.plannedHours}, ${input.isBillable ?? true},
        ${input.billItemId ?? null}, ${input.projectTaskId ?? null}, ${validated.booking}, 'active',
        ${validated.source}, ${input.requestId ?? null}, ${input.custom ?? {}}, ${input.actorId}, ${input.actorId}
      )
      on conflict (org_id, project_id, week_start,
        (coalesce(employee_party_id::text, lower(job_title))))
      do update set
        planned_hours = excluded.planned_hours,
        is_billable = excluded.is_billable,
        bill_item_id = excluded.bill_item_id,
        project_task_id = excluded.project_task_id,
        booking = excluded.booking,
        source = excluded.source,
        request_id = excluded.request_id,
        custom = case when ${input.custom === undefined} then res_assignments.custom else excluded.custom end,
        state = 'active',
        updated_at = now(),
        updated_by = excluded.updated_by
      returning ${ASSIGNMENT_COLUMNS}
    `);
    const assignment = rowResult.rows[0];
    if (!assignment || (rowResult.rowCount ?? 0) !== 1) {
      throw new Error("the assignment upsert did not return its written row");
    }
    const weeklyTotals = input.employeePartyId
      ? await readWeeklyTotals(tx, input, validated.figure?.netCapacity ?? null)
      : null;
    return { assignment, weeklyTotals };
  });
}

interface AssignmentIdInput extends AssignmentWriteContext {
  assignmentId: string;
}

async function lockAssignment(
  tx: SqlExecutor,
  input: AssignmentIdInput,
): Promise<AssignmentRow> {
  const initial = (await tx.execute<{ project_id: string }>(sql`
    select project_id from res_assignments where org_id = ${input.orgId} and id = ${input.assignmentId}
  `)).rows[0];
  if (!initial) {
    refuse("assignment_unknown", `assignment ${input.assignmentId} does not exist`, "reload the assignment list", "assignmentId");
  }
  await lockProjectForScope(tx, input.orgId, initial.project_id, input.allowedSubsidiaryIds, "share");
  const locked = (await tx.execute<AssignmentRow>(sql`
    select ${ASSIGNMENT_COLUMNS} from res_assignments
     where org_id = ${input.orgId} and id = ${input.assignmentId}
       and project_id = ${initial.project_id}
     for update
  `)).rows[0];
  if (!locked) {
    refuse(
      "assignment_changed",
      `assignment ${input.assignmentId} changed while it was being loaded`,
      "reload the assignment and retry the change",
      "assignmentId",
      409,
    );
  }
  return locked;
}

/** Mark an assignment released, retaining it for plan-versus-actual evidence. */
export async function releaseAssignment(input: AssignmentIdInput): Promise<AssignmentWriteResult> {
  return inAssignmentWrite(input, async (tx) => {
    const current = await lockAssignment(tx, input);
    if (current.state !== "active") {
      refuse(
        "assignment_not_active",
        `assignment ${input.assignmentId} is already released`,
        "reload the assignment and choose an active assignment",
        "assignmentId",
        409,
      );
    }
    const updated = await tx.execute<AssignmentRow>(sql`
      update res_assignments set state = 'released', updated_at = now(), updated_by = ${input.actorId}
       where org_id = ${input.orgId} and id = ${input.assignmentId} and state = 'active'
      returning ${ASSIGNMENT_COLUMNS}
    `);
    if ((updated.rowCount ?? 0) !== 1 || !updated.rows[0]) {
      refuse(
        "assignment_not_active",
        `assignment ${input.assignmentId} is no longer active`,
        "reload the assignment and choose an active assignment",
        "assignmentId",
        409,
      );
    }
    const assignment = updated.rows[0];
    const availability = assignment.employeePartyId
      ? await readAvailability(
        input.orgId,
        [assignment.employeePartyId],
        assignment.weekStart,
        assignment.weekStart,
        input.allowedSubsidiaryIds,
      )
      : [];
    const figure = availability.find((row) => row.employeePartyId === assignment.employeePartyId);
    const weeklyTotals = assignment.employeePartyId
      ? await readWeeklyTotals(tx, {
        ...input,
        employeePartyId: assignment.employeePartyId,
        weekStart: assignment.weekStart,
      }, figure?.netCapacity ?? null)
      : null;
    return { assignment, weeklyTotals };
  });
}

/** Delete a plan row only while no approved time relies on its history. */
export async function deleteAssignment(input: AssignmentIdInput): Promise<void> {
  await inAssignmentWrite(input, async (tx) => {
    const current = await lockAssignment(tx, input);
    if (current.employeePartyId) {
      const saturday = addCalendarDays(current.weekStart, 6);
      const actual = (await tx.execute<{ id: string }>(sql`
        select id from time_entries
         where org_id = ${input.orgId}
           and employee_party_id = ${current.employeePartyId}
           and project_id = ${current.projectId}
           and worked_on >= ${current.weekStart} and worked_on <= ${saturday}
           and status = 'approved'
         limit 1
      `)).rows[0];
      if (actual) {
        refuse(
          "assignment_has_approved_time",
          `assignment ${input.assignmentId} has approved time in its project week`,
          "release it; plan-vs-actual history is kept",
          "assignmentId",
          409,
        );
      }
    }
    const deleted = await tx.execute(sql`
      delete from res_assignments where org_id = ${input.orgId} and id = ${input.assignmentId}
    `);
    if ((deleted.rowCount ?? 0) !== 1) {
      refuse(
        "assignment_changed",
        `assignment ${input.assignmentId} was not deleted because it changed concurrently`,
        "reload the assignment and retry the deletion",
        "assignmentId",
        409,
      );
    }
  });
}
