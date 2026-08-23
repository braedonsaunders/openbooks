import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import type {
  ScheduleData,
  ScheduleDependency,
  ScheduleTask,
  ScheduleTaskPatchInput,
} from '@appkit/scheduling'
import { wouldCreateDependencyCycle } from '@appkit/scheduling'
import { canonicalDecimal } from './exact-decimal'

/**
 * Project schedule persistence.
 *
 * The scheduled activity is `project_tasks`; this module maps those rows (plus
 * the dependency/calendar/resource/baseline tables) into the shape
 * `@appkit/scheduling` reads, and writes patches back. Every query is org- and
 * project-scoped: the schedule surface never sees another tenant's plan, and a
 * task id from a different project is rejected rather than silently updated.
 *
 * Nothing here posts to the ledger. A schedule is planning data.
 */

type Row = Record<string, unknown>

const str = (value: unknown) => (value == null ? null : String(value))
const num = (value: unknown) => (value == null ? 0 : Number(value))

function toTask(row: Row): ScheduleTask {
  return {
    id: String(row.id),
    phaseId: str(row.schedule_phase),
    calendarId: str(row.schedule_calendar_id),
    parentTaskId: str(row.parent_id),
    outlineLevel: num(row.schedule_outline_level),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    taskType: (row.schedule_task_type as ScheduleTask['taskType']) ?? 'task',
    status: (row.schedule_status as ScheduleTask['status']) ?? 'not_started',
    startDate: str(row.schedule_start),
    endDate: str(row.schedule_end),
    duration: num(row.schedule_duration),
    progress: num(row.schedule_progress),
    assignee: String(row.schedule_assignee ?? ''),
    order: num(row.schedule_order),
    constraintType: (row.schedule_constraint_type as ScheduleTask['constraintType']) ?? 'asap',
    constraintDate: str(row.schedule_constraint_date),
    deadlineDate: str(row.schedule_deadline_date),
    actualStart: str(row.schedule_actual_start),
    actualEnd: str(row.schedule_actual_end),
    // Baseline values are overlaid client-side from the selected baseline, so
    // the same task row can be measured against any captured baseline.
    baselineStart: null,
    baselineEnd: null,
  }
}

/** Load the whole plan for one project. */
export async function loadProjectSchedule(orgId: string, projectId: string): Promise<ScheduleData> {
  const [tasks, dependencies, calendars, resources, assignments, baselines, baselineTasks] =
    await Promise.all([
      db.execute(sql`
        select * from project_tasks
         where org_id = ${orgId} and project_id = ${projectId}
         order by schedule_order, name`),
      db.execute(sql`
        select id, predecessor_id, successor_id, type, lag_days
          from schedule_dependencies
         where org_id = ${orgId} and project_id = ${projectId}`),
      db.execute(sql`
        select * from schedule_calendars
         where org_id = ${orgId} and (project_id = ${projectId} or project_id is null)
         order by is_default desc, name`),
      db.execute(sql`
        select * from schedule_resources
         where org_id = ${orgId} and (project_id = ${projectId} or project_id is null)
           and is_active
         order by name`),
      db.execute(sql`
        select a.* from schedule_task_assignments a
          join project_tasks t on t.id = a.task_id
         where a.org_id = ${orgId} and t.project_id = ${projectId}`),
      db.execute(sql`
        select * from schedule_baselines
         where org_id = ${orgId} and project_id = ${projectId}
         order by is_primary desc, created_at desc`),
      db.execute(sql`
        select bt.* from schedule_baseline_tasks bt
          join schedule_baselines b on b.id = bt.baseline_id
         where bt.org_id = ${orgId} and b.project_id = ${projectId}`),
    ])

  const taskRows = (tasks as unknown as { rows: Row[] }).rows
  const phaseNames = [
    ...new Set(taskRows.map((row) => str(row.schedule_phase)).filter((v): v is string => !!v)),
  ].sort()

  return {
    tasks: taskRows.map(toTask),
    dependencies: (dependencies as unknown as { rows: Row[] }).rows.map((row) => ({
      id: String(row.id),
      predecessorId: String(row.predecessor_id),
      successorId: String(row.successor_id),
      type: (row.type as ScheduleDependency['type']) ?? 'FS',
      lagDays: num(row.lag_days),
    })),
    // Phases are a free-text grouping band on the task, so the phase list is
    // derived from what the tasks actually use — no second table to keep in sync.
    phases: phaseNames.map((name, index) => ({ id: name, name, order: index + 1 })),
    calendars: (calendars as unknown as { rows: Row[] }).rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      description: String(row.description ?? ''),
      isDefault: row.is_default === true,
      workingDays: (row.working_days as Record<string, boolean>) ?? {},
      holidays: (row.holidays as string[]) ?? [],
      shiftStartMinutes: num(row.shift_start_minutes),
      shiftEndMinutes: num(row.shift_end_minutes),
    })),
    resources: (resources as unknown as { rows: Row[] }).rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      role: String(row.role ?? ''),
      kind: (row.kind as 'labor' | 'crew' | 'equipment' | 'subcontractor') ?? 'crew',
      calendarId: str(row.calendar_id),
      color: str(row.color),
      defaultUnits: num(row.default_units) || 1,
      capacityPerDay: num(row.capacity_per_day) || 1,
      costRate: row.cost_rate == null ? undefined : Number(row.cost_rate),
    })),
    assignments: (assignments as unknown as { rows: Row[] }).rows.map((row) => ({
      id: String(row.id),
      taskId: String(row.task_id),
      resourceId: String(row.resource_id),
      units: num(row.units) || 1,
      role: String(row.role ?? ''),
    })),
    baselines: (baselines as unknown as { rows: Row[] }).rows.map((row) => ({
      id: String(row.id),
      name: String(row.name ?? ''),
      description: String(row.description ?? ''),
      kind: (row.kind as 'primary' | 'secondary' | 'tertiary' | 'snapshot' | 'custom') ?? 'snapshot',
      isPrimary: row.is_primary === true,
      capturedAt: str(row.created_at) ?? undefined,
    })),
    baselineTasks: (baselineTasks as unknown as { rows: Row[] }).rows.map((row) => ({
      id: String(row.id),
      baselineId: String(row.baseline_id),
      taskId: String(row.task_id),
      taskName: String(row.task_name ?? ''),
      startDate: str(row.start_date),
      endDate: str(row.end_date),
      duration: num(row.duration),
    })),
  }
}

export class ScheduleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Confirm a task belongs to this org AND this project before touching it. */
async function assertTaskInProject(orgId: string, projectId: string, taskId: string) {
  const r = (await db.execute<Row>(sql`
    select 1 from project_tasks
     where id = ${taskId} and org_id = ${orgId} and project_id = ${projectId}`))
  if (!r.rows[0]) throw new ScheduleError('task not found', 404)
}

/**
 * Column mapping for a task patch. Only these fields are writable from the
 * schedule surface — an allowlist, so a crafted patch can never reach the
 * costing columns (estimates, code, status) that job costing depends on.
 */
const TASK_COLUMNS: Record<string, string> = {
  name: 'name',
  description: 'description',
  taskType: 'schedule_task_type',
  status: 'schedule_status',
  startDate: 'schedule_start',
  endDate: 'schedule_end',
  duration: 'schedule_duration',
  progress: 'schedule_progress',
  assignee: 'schedule_assignee',
  order: 'schedule_order',
  outlineLevel: 'schedule_outline_level',
  parentTaskId: 'parent_id',
  calendarId: 'schedule_calendar_id',
  phaseId: 'schedule_phase',
  constraintType: 'schedule_constraint_type',
  constraintDate: 'schedule_constraint_date',
  deadlineDate: 'schedule_deadline_date',
  actualStart: 'schedule_actual_start',
  actualEnd: 'schedule_actual_end',
}

function patchValue(key: string, value: unknown) {
  if (value === '' && key.endsWith('Date')) return null
  if (key === 'progress') {
    const fraction = Number(value)
    if (!Number.isFinite(fraction)) return 0
    // Accept 0–1 or 0–100 and clamp: the column constraint is a fraction.
    return Math.max(0, Math.min(1, fraction > 1 ? fraction / 100 : fraction))
  }
  if (key === 'duration' || key === 'order' || key === 'outlineLevel') {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
  }
  return value === undefined ? null : value
}

/** `exec` lets callers run the patch inside an open transaction. */
type Executor = Pick<typeof db, 'execute'>

async function applyTaskPatch(
  orgId: string,
  projectId: string,
  taskId: string,
  patch: ScheduleTaskPatchInput,
  userId: string | null,
  exec: Executor = db,
) {
  const entries = Object.entries(patch).filter(
    ([key, value]) => key in TASK_COLUMNS && value !== undefined,
  )

  if (entries.length > 0) {
    const assignments = entries.map(
      ([key, value]) =>
        sql`${sql.raw(`"${TASK_COLUMNS[key]}"`)} = ${patchValue(key, value) as never}`,
    )
    await exec.execute(sql`
      update project_tasks
         set ${sql.join(assignments, sql`, `)},
             updated_at = now(),
             updated_by = ${userId}
       where id = ${taskId} and org_id = ${orgId} and project_id = ${projectId}`)
  }

  // Resource assignments are replaced wholesale — the editor sends the complete
  // set, and a diff would leave orphans when a row is removed.
  if (patch.resourceAssignments) {
    await exec.execute(sql`
      delete from schedule_task_assignments where org_id = ${orgId} and task_id = ${taskId}`)
    for (const assignment of patch.resourceAssignments) {
      if (!assignment.resourceId) continue
      await exec.execute(sql`
        insert into schedule_task_assignments (org_id, task_id, resource_id, units, role, created_by, updated_by)
        values (${orgId}, ${taskId}, ${assignment.resourceId},
                ${Math.max(0.0001, Number(assignment.units ?? 1) || 1)}, ${assignment.role ?? ''},
                ${userId}, ${userId})
        on conflict (task_id, resource_id)
          do update set units = excluded.units, role = excluded.role, updated_at = now(), updated_by = ${userId}
          where schedule_task_assignments.org_id = ${orgId}`)
    }
  }
}

export async function updateScheduleTask(
  orgId: string,
  projectId: string,
  taskId: string,
  patch: ScheduleTaskPatchInput,
  userId: string | null,
) {
  await assertTaskInProject(orgId, projectId, taskId)
  await applyTaskPatch(orgId, projectId, taskId, patch, userId)
}

/**
 * Apply many patches as one unit. Outline moves renumber every row, so a
 * partial write would leave the plan's order inconsistent.
 */
export async function batchUpdateScheduleTasks(
  orgId: string,
  projectId: string,
  updates: Array<{ id: string } & ScheduleTaskPatchInput>,
  userId: string | null,
) {
  for (const update of updates) await assertTaskInProject(orgId, projectId, update.id)
  await db.transaction(async (tx) => {
    for (const { id, ...patch } of updates) {
      await applyTaskPatch(orgId, projectId, id, patch, userId, tx)
    }
  })
}

export async function createScheduleTask(
  orgId: string,
  projectId: string,
  input: ScheduleTaskPatchInput & { name: string },
  userId: string | null,
) {
  const next = (await db.execute<{ n: number }>(sql`
    select coalesce(max(schedule_order), 0) + 1 as n from project_tasks
     where org_id = ${orgId} and project_id = ${projectId}`))
  const created = (await db.execute<{ id: string }>(sql`
    insert into project_tasks (org_id, project_id, name, schedule_order, created_by, updated_by)
    values (${orgId}, ${projectId}, ${input.name || 'New task'},
            ${input.order ?? next.rows[0]?.n ?? 1}, ${userId}, ${userId})
    returning id`))
  const id = created.rows[0]?.id
  if (!id) throw new ScheduleError('could not create task', 500)
  const { name: _name, order: _order, ...rest } = input
  await applyTaskPatch(orgId, projectId, id, rest, userId)
  return id
}

export async function deleteScheduleTask(orgId: string, projectId: string, taskId: string) {
  await assertTaskInProject(orgId, projectId, taskId)
  // A task with posted time is job-costing history; refuse rather than orphan it.
  const timeEntries = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from time_entries
     where org_id = ${orgId} and project_task_id = ${taskId}`))
  if ((timeEntries.rows[0]?.n ?? 0) > 0) {
    throw new ScheduleError('task has time entries and cannot be deleted', 409)
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from schedule_dependencies
       where org_id = ${orgId} and (predecessor_id = ${taskId} or successor_id = ${taskId})`)
    await tx.execute(sql`
      delete from schedule_task_assignments where org_id = ${orgId} and task_id = ${taskId}`)
    // Children are lifted to the top of the outline, never deleted with the parent.
    await tx.execute(sql`
      update project_tasks set parent_id = null, schedule_outline_level = 0
       where org_id = ${orgId} and parent_id = ${taskId}`)
    await tx.execute(sql`
      delete from project_tasks
       where id = ${taskId} and org_id = ${orgId} and project_id = ${projectId}`)
  })
}

export async function createScheduleDependency(
  orgId: string,
  projectId: string,
  input: { predecessorId: string; successorId: string; type?: string; lagDays?: number },
  userId: string | null,
) {
  await assertTaskInProject(orgId, projectId, input.predecessorId)
  await assertTaskInProject(orgId, projectId, input.successorId)

  // Refuse loops at the boundary: a cycle makes the critical path undefined for
  // the whole project, and the UI can only prevent the ones it can see.
  const existing = (await db.execute<Row>(sql`
    select id, predecessor_id, successor_id, type, lag_days from schedule_dependencies
     where org_id = ${orgId} and project_id = ${projectId}`))
  const dependencies: ScheduleDependency[] = existing.rows.map((row) => ({
    id: String(row.id),
    predecessorId: String(row.predecessor_id),
    successorId: String(row.successor_id),
    type: (row.type as ScheduleDependency['type']) ?? 'FS',
    lagDays: num(row.lag_days),
  }))
  if (wouldCreateDependencyCycle(dependencies, input.predecessorId, input.successorId)) {
    throw new ScheduleError('that dependency would create a loop in the schedule', 409)
  }

  await db.execute(sql`
    insert into schedule_dependencies (org_id, project_id, predecessor_id, successor_id, type, lag_days, created_by, updated_by)
    values (${orgId}, ${projectId}, ${input.predecessorId}, ${input.successorId},
            ${input.type ?? 'FS'}, ${Math.trunc(Number(input.lagDays ?? 0)) || 0}, ${userId}, ${userId})
    on conflict (predecessor_id, successor_id)
      do update set type = excluded.type, lag_days = excluded.lag_days, updated_at = now(), updated_by = ${userId}
      where schedule_dependencies.org_id = ${orgId}`)
}

export async function deleteScheduleDependency(orgId: string, projectId: string, id: string) {
  await db.execute(sql`
    delete from schedule_dependencies
     where id = ${id} and org_id = ${orgId} and project_id = ${projectId}`)
}

/** Capture the current plan as a baseline. */
export async function createScheduleBaseline(
  orgId: string,
  projectId: string,
  input: { name: string; description?: string; kind?: string; isPrimary?: boolean },
  userId: string | null,
) {
  await db.transaction(async (tx) => {
    if (input.isPrimary) {
      await tx.execute(sql`
        update schedule_baselines set is_primary = false, updated_at = now(), updated_by = ${userId}
         where org_id = ${orgId} and project_id = ${projectId} and is_primary`)
    }
    const created = (await tx.execute<{ id: string }>(sql`
      insert into schedule_baselines (org_id, project_id, name, description, kind, is_primary, created_by, updated_by)
      values (${orgId}, ${projectId}, ${input.name}, ${input.description ?? null},
              ${input.kind ?? (input.isPrimary ? 'primary' : 'snapshot')}, ${input.isPrimary === true},
              ${userId}, ${userId})
      returning id`))
    const baselineId = created.rows[0]?.id
    if (!baselineId) throw new ScheduleError('could not create baseline', 500)
    await tx.execute(sql`
      insert into schedule_baseline_tasks
        (org_id, baseline_id, task_id, task_name, start_date, end_date, duration, created_by, updated_by)
      select ${orgId}, ${baselineId}, id, name, schedule_start, schedule_end, schedule_duration, ${userId}, ${userId}
        from project_tasks
       where org_id = ${orgId} and project_id = ${projectId}`)
  })
}

export async function deleteScheduleBaseline(orgId: string, projectId: string, baselineId: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from schedule_baseline_tasks
       where org_id = ${orgId} and baseline_id = ${baselineId}`)
    await tx.execute(sql`
      delete from schedule_baselines
       where id = ${baselineId} and org_id = ${orgId} and project_id = ${projectId}`)
  })
}

export async function upsertScheduleCalendar(
  orgId: string,
  projectId: string,
  input: {
    id?: string
    name?: string
    description?: string
    workingDays?: Record<string, boolean>
    holidays?: string[]
    isDefault?: boolean
  },
  userId: string | null,
) {
  if (input.isDefault) {
    await db.execute(sql`
      update schedule_calendars set is_default = false, updated_at = now(), updated_by = ${userId}
       where org_id = ${orgId} and (project_id = ${projectId} or project_id is null) and is_default`)
  }
  if (input.id) {
    await db.execute(sql`
      update schedule_calendars
         set name = coalesce(${input.name ?? null}, name),
             description = coalesce(${input.description ?? null}, description),
             working_days = coalesce(${input.workingDays ? JSON.stringify(input.workingDays) : null}::jsonb, working_days),
             holidays = coalesce(${input.holidays ? JSON.stringify(input.holidays) : null}::jsonb, holidays),
             is_default = coalesce(${input.isDefault ?? null}, is_default),
             updated_at = now(), updated_by = ${userId}
       where id = ${input.id} and org_id = ${orgId}`)
    return input.id
  }
  const created = (await db.execute<{ id: string }>(sql`
    insert into schedule_calendars (org_id, project_id, name, description, working_days, holidays, is_default, created_by, updated_by)
    values (${orgId}, ${projectId}, ${input.name ?? 'Calendar'}, ${input.description ?? null},
            coalesce(${input.workingDays ? JSON.stringify(input.workingDays) : null}::jsonb,
                     '{"0":false,"1":true,"2":true,"3":true,"4":true,"5":true,"6":false}'::jsonb),
            coalesce(${input.holidays ? JSON.stringify(input.holidays) : null}::jsonb, '[]'::jsonb),
            ${input.isDefault === true}, ${userId}, ${userId})
    returning id`))
  return created.rows[0]?.id ?? null
}

export async function deleteScheduleCalendar(orgId: string, calendarId: string) {
  await db.transaction(async (tx) => {
    // Tasks and resources fall back to the default calendar rather than
    // pointing at a calendar that no longer exists.
    await tx.execute(sql`
      update project_tasks set schedule_calendar_id = null
       where org_id = ${orgId} and schedule_calendar_id = ${calendarId}`)
    await tx.execute(sql`
      update schedule_resources set calendar_id = null
       where org_id = ${orgId} and calendar_id = ${calendarId}`)
    await tx.execute(sql`
      delete from schedule_calendars where id = ${calendarId} and org_id = ${orgId}`)
  })
}

function optionalCostRate(value: unknown): string | null | 'invalid' {
  if (value == null || value === '') return null
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return 'invalid'
  return normalizeMoney(exact)
}

export async function upsertScheduleResource(
  orgId: string,
  projectId: string,
  input: {
    id?: string
    name?: string
    role?: string
    kind?: string
    calendarId?: string | null
    defaultUnits?: number
    capacityPerDay?: number
    costRate?: string | number | null
  },
  userId: string | null,
) {
  const costRate = input.costRate === undefined
    ? undefined
    : optionalCostRate(input.costRate)
  if (costRate === 'invalid') {
    throw new ScheduleError('cost rate must be a number with no more than four decimal places', 422)
  }
  if (input.id) {
    await db.execute(sql`
      update schedule_resources
         set name = coalesce(${input.name ?? null}, name),
             role = coalesce(${input.role ?? null}, role),
             kind = coalesce(${input.kind ?? null}, kind),
             calendar_id = ${input.calendarId === undefined ? sql`calendar_id` : input.calendarId},
             default_units = coalesce(${input.defaultUnits ?? null}, default_units),
             capacity_per_day = coalesce(${input.capacityPerDay ?? null}, capacity_per_day),
             cost_rate = ${costRate === undefined ? sql`cost_rate` : sql`${costRate}`},
             updated_at = now(), updated_by = ${userId}
       where id = ${input.id} and org_id = ${orgId}`)
    return input.id
  }
  const created = (await db.execute<{ id: string }>(sql`
    insert into schedule_resources
      (org_id, project_id, calendar_id, name, role, kind, default_units, capacity_per_day, cost_rate, created_by, updated_by)
    values (${orgId}, ${projectId}, ${input.calendarId ?? null}, ${input.name ?? 'Resource'},
            ${input.role ?? null}, ${input.kind ?? 'crew'},
            ${Math.max(0.0001, Number(input.defaultUnits ?? 1) || 1)},
            ${Math.max(0.0001, Number(input.capacityPerDay ?? 1) || 1)},
            ${costRate ?? null}, ${userId}, ${userId})
    returning id`))
  return created.rows[0]?.id ?? null
}

export async function deleteScheduleResource(orgId: string, resourceId: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      delete from schedule_task_assignments where org_id = ${orgId} and resource_id = ${resourceId}`)
    await tx.execute(sql`
      delete from schedule_resources where id = ${resourceId} and org_id = ${orgId}`)
  })
}
