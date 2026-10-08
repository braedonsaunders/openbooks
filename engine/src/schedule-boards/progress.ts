/**
 * Task-board production progress: each project task's budget hours, the
 * approved hours charged to it, and the percent complete recorded on its
 * schedule, with the earned-value measures derived from them. Arithmetic is
 * exact 4-decimal; a measure whose inputs are missing is null, never zero.
 */
import { sql } from "drizzle-orm";
import { add, cmp, div, mul, neg } from "../money/money.ts";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { getBoard, type ScheduleActor } from "./boards.ts";
import { ScheduleError, scheduleDatabaseRefusal } from "./errors.ts";

export interface TaskProgress {
  readonly id: string;
  readonly parentId: string | null;
  readonly code: string | null;
  readonly name: string;
  readonly phase: string | null;
  readonly outlineLevel: number;
  readonly scheduleStatus: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly budgetHours: string | null;
  readonly actualHours: string;
  readonly pendingHours: string;
  /** Fraction complete, 0 through 1. */
  readonly percentComplete: string;
  readonly earnedHours: string | null;
  readonly remainingHours: string | null;
  readonly hoursUsed: string | null;
  readonly performanceFactor: string | null;
  readonly hoursToComplete: string | null;
  readonly estimateAtCompletion: string | null;
  readonly varianceAtCompletion: string | null;
}

export interface ProgressTotals {
  readonly budgetHours: string;
  readonly actualHours: string;
  readonly pendingHours: string;
  readonly earnedHours: string;
  readonly percentComplete: string | null;
  readonly performanceFactor: string | null;
  readonly hoursToComplete: string | null;
  readonly estimateAtCompletion: string | null;
  readonly varianceAtCompletion: string | null;
}

export interface ProjectProgress {
  readonly projectId: string;
  readonly projectName: string;
  readonly tasks: readonly TaskProgress[];
  readonly totals: ProgressTotals;
}

const positive = (value: string | null): value is string => value !== null && cmp(value, "0") > 0;

/** Earned-value measures for one task from its budget, approved actuals and fraction complete. */
export function taskMeasures(budget: string | null, actual: string, percent: string) {
  const earned = budget === null ? null : mul(percent, budget);
  const remaining = budget === null ? null : add(budget, neg(actual));
  const hoursUsed = positive(budget) ? div(actual, budget) : null;
  const performanceFactor = earned !== null && positive(actual) ? div(earned, actual) : null;
  // Hours still needed at the productivity achieved so far: actual × (1 − p) ÷ p.
  const hoursToComplete = cmp(percent, "1") >= 0 ? "0.0000"
    : positive(percent) && positive(actual) ? div(mul(actual, add("1", neg(percent))), percent) : null;
  const estimateAtCompletion = hoursToComplete === null ? null : add(actual, hoursToComplete);
  const varianceAtCompletion = budget === null || estimateAtCompletion === null ? null : add(budget, neg(estimateAtCompletion));
  return { earned, remaining, hoursUsed, performanceFactor, hoursToComplete, estimateAtCompletion, varianceAtCompletion };
}

export function loadProjectProgress(actor: ScheduleActor & { boardId: string; projectId: string }): Promise<ProjectProgress> {
  return withOrgTransaction(actor.orgId, () => readProjectProgress(actor)).catch((error: unknown) => { throw scheduleDatabaseRefusal(error); });
}

async function readProjectProgress(actor: ScheduleActor & { boardId: string; projectId: string }): Promise<ProjectProgress> {
  const board = await getBoard(actor, actor.boardId);
  if (board.rowKind !== "tasks") throw new ScheduleError("Progress is measured on task boards.", { code: "schedule_wrong_board" });
  if (!isUuid(actor.projectId)) throw new ScheduleError("Choose a project.", { code: "schedule_invalid" });
  if (board.projectId && board.projectId !== actor.projectId) throw new ScopeNotFoundError();
  const allowed = await lockActorCommandAuthority(db, actor.orgId, actor.actorId, null, "projects.read");
  const project = (await db.execute<{ id: string; name: string }>(sql`select id, name from projects
    where org_id = ${actor.orgId} and id = ${actor.projectId} ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })}`)).rows[0];
  if (!project) throw new ScopeNotFoundError();

  const rows = (await db.execute<{
    id: string; parentId: string | null; code: string | null; name: string; phase: string | null; outlineLevel: number;
    scheduleStatus: string; startDate: string | null; endDate: string | null; budgetHours: string | null; percent: string;
    actualHours: string; pendingHours: string;
  }>(sql`
    select t.id, t.parent_id as "parentId", t.code, t.name, t.schedule_phase as phase, t.schedule_outline_level as "outlineLevel",
           t.schedule_status as "scheduleStatus", t.schedule_start::text as "startDate", t.schedule_end::text as "endDate",
           t.estimated_hours::text as "budgetHours", t.schedule_progress::text as percent,
           coalesce(sum(te.hours) filter (where te.status = 'approved'), 0)::numeric(19,4)::text as "actualHours",
           coalesce(sum(te.hours) filter (where te.status in ('draft', 'submitted')), 0)::numeric(19,4)::text as "pendingHours"
      from project_tasks t
      left join time_entries te on te.org_id = t.org_id and te.project_task_id = t.id
     where t.org_id = ${actor.orgId} and t.project_id = ${actor.projectId} and t.status <> 'cancelled'
     group by t.id
     order by t.schedule_order, t.code nulls last, t.name, t.id
  `)).rows;

  const tasks: TaskProgress[] = rows.map((row) => {
    const measures = taskMeasures(row.budgetHours, row.actualHours, row.percent);
    return {
      id: row.id, parentId: row.parentId, code: row.code, name: row.name, phase: row.phase, outlineLevel: row.outlineLevel,
      scheduleStatus: row.scheduleStatus, startDate: row.startDate, endDate: row.endDate,
      budgetHours: row.budgetHours, actualHours: row.actualHours, pendingHours: row.pendingHours, percentComplete: row.percent,
      earnedHours: measures.earned, remainingHours: measures.remaining, hoursUsed: measures.hoursUsed,
      performanceFactor: measures.performanceFactor, hoursToComplete: measures.hoursToComplete,
      estimateAtCompletion: measures.estimateAtCompletion, varianceAtCompletion: measures.varianceAtCompletion,
    };
  });

  // Rollups count leaf work only, so a summary row's own figures never double a child's.
  const parents = new Set(tasks.map((task) => task.parentId).filter((id): id is string => id !== null));
  const leaves = tasks.filter((task) => !parents.has(task.id));
  const budgeted = leaves.filter((task) => task.budgetHours !== null);
  const total = (values: (string | null)[]) => values.reduce<string>((acc, value) => add(acc, value ?? "0"), "0.0000");
  const budgetHours = total(budgeted.map((task) => task.budgetHours));
  const actualHours = total(leaves.map((task) => task.actualHours));
  const earnedHours = total(budgeted.map((task) => task.earnedHours));
  const percentComplete = positive(budgetHours) ? div(earnedHours, budgetHours) : null;
  const performanceFactor = positive(actualHours) ? div(earnedHours, actualHours) : null;
  const toComplete = leaves.every((task) => task.hoursToComplete !== null) ? total(leaves.map((task) => task.hoursToComplete)) : null;
  const estimateAtCompletion = toComplete === null ? null : add(actualHours, toComplete);
  return {
    projectId: project.id,
    projectName: project.name,
    tasks,
    totals: {
      budgetHours,
      actualHours,
      pendingHours: total(leaves.map((task) => task.pendingHours)),
      earnedHours,
      percentComplete,
      performanceFactor,
      hoursToComplete: toComplete,
      estimateAtCompletion,
      varianceAtCompletion: estimateAtCompletion === null ? null : add(budgetHours, neg(estimateAtCompletion)),
    },
  };
}
