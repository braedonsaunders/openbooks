import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  ProjectWorkBreakdownError,
  type WorkBreakdownTaskInput,
} from './project-work-breakdown-validation'

type TaskStatus = WorkBreakdownTaskInput['status']

type Executor = Pick<typeof db, 'execute'>
type TaskRow = {
  id: string
  project_id: string
  code: string | null
  name: string
  status: TaskStatus
  estimated_hours: string | null
  estimated_cost: string | null
  updated_at: string | Date
};

export interface WorkBreakdownTaskClient {
  id: string
  code: string
  name: string
  status: TaskStatus
  estimatedHours: string
  estimatedCost: string
  updatedAt: string
}

function clientTask(row: TaskRow): WorkBreakdownTaskClient {
  return {
    id: row.id,
    code: row.code ?? '',
    name: row.name,
    status: row.status,
    estimatedHours: row.estimated_hours ?? '',
    estimatedCost: row.estimated_cost ?? '',
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

async function assertProject(
  exec: Executor,
  orgId: string,
  projectId: string,
  lock: 'none' | 'share' | 'update' = 'none',
): Promise<void> {
  const project = (await exec.execute<{ id: string }>(sql`
    select id from projects
     where id = ${projectId} and org_id = ${orgId}
     ${lock === 'update' ? sql`for update` : lock === 'share' ? sql`for share` : sql``}
  `))
  if (!project.rows[0]) throw new ProjectWorkBreakdownError('Project not found', 404)
}

async function taskSnapshot(
  exec: Executor,
  orgId: string,
  projectId: string,
  taskId: string,
  lock = false,
): Promise<TaskRow | null> {
  const result = (await exec.execute<TaskRow>(sql`
    select id, project_id, code, name, status, estimated_hours, estimated_cost, updated_at
      from project_tasks
     where id = ${taskId} and project_id = ${projectId} and org_id = ${orgId}
     ${lock ? sql`for update` : sql``}
  `))
  return result.rows[0] ?? null
}

async function recordTaskAudit(args: {
  exec: Executor
  orgId: string
  projectId: string
  taskId: string
  actorId: string
  action: 'insert' | 'update'
  before: TaskRow | null
  after: TaskRow
}) {
  await args.exec.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${args.orgId},
      'project_tasks',
      ${args.taskId},
      ${args.action},
      ${JSON.stringify({
        projectId: args.projectId,
        source: 'project_work_breakdown',
        before: args.before,
        after: args.after,
      })}::jsonb,
      ${args.actorId}
    )
  `)
}

export async function loadWorkBreakdownTasks(
  orgId: string,
  projectId: string,
): Promise<WorkBreakdownTaskClient[]> {
  await assertProject(db, orgId, projectId)
  const result = (await db.execute<TaskRow>(sql`
    select id, project_id, code, name, status, estimated_hours, estimated_cost, updated_at
      from project_tasks
     where project_id = ${projectId} and org_id = ${orgId}
     order by code nulls last, name, id
  `))
  return result.rows.map(clientTask)
}

export async function createWorkBreakdownTask(args: {
  orgId: string
  projectId: string
  actorId: string
  input: WorkBreakdownTaskInput
}): Promise<WorkBreakdownTaskClient> {
  return db.transaction(async (tx) => {
    // The project row is the transaction-scoped sequencing lock for its WBS.
    // Concurrent creates cannot both observe the same max(schedule_order).
    await assertProject(tx, args.orgId, args.projectId, 'update')
    const created = (await tx.execute<TaskRow>(sql`
      insert into project_tasks (
        org_id, project_id, code, name, status, estimated_hours, estimated_cost,
        schedule_order, created_by, updated_by
      )
      values (
        ${args.orgId}, ${args.projectId}, ${args.input.code}, ${args.input.name},
        ${args.input.status}, ${args.input.estimatedHours}, ${args.input.estimatedCost},
        coalesce((
          select max(schedule_order) + 1 from project_tasks
           where org_id = ${args.orgId} and project_id = ${args.projectId}
        ), 1),
        ${args.actorId}, ${args.actorId}
      )
      returning id, project_id, code, name, status, estimated_hours, estimated_cost, updated_at
    `))
    const after = created.rows[0]
    if (!after) throw new ProjectWorkBreakdownError('Task could not be created', 500)
    await recordTaskAudit({
      exec: tx,
      orgId: args.orgId,
      projectId: args.projectId,
      taskId: after.id,
      actorId: args.actorId,
      action: 'insert',
      before: null,
      after,
    })
    return clientTask(after)
  })
}

export async function updateWorkBreakdownTask(args: {
  orgId: string
  projectId: string
  taskId: string
  actorId: string
  expectedUpdatedAt: string
  input: WorkBreakdownTaskInput
}): Promise<WorkBreakdownTaskClient> {
  return db.transaction(async (tx) => {
    await assertProject(tx, args.orgId, args.projectId, 'share')
    const before = await taskSnapshot(tx, args.orgId, args.projectId, args.taskId, true)
    if (!before) throw new ProjectWorkBreakdownError('Task not found', 404)
    if (new Date(before.updated_at).toISOString() !== args.expectedUpdatedAt) {
      throw new ProjectWorkBreakdownError(
        'This task changed after you opened it. Refresh and review the latest values.',
        409,
      )
    }

    // `updated_at` can retain PostgreSQL microseconds while JavaScript ISO
    // strings carry milliseconds. The locked snapshot comparison above is the
    // optimistic-concurrency decision; repeating it in SQL with the truncated
    // client value would incorrectly reject an otherwise current editor.
    const updated = (await tx.execute<TaskRow>(sql`
      update project_tasks
         set code = ${args.input.code},
             name = ${args.input.name},
             status = ${args.input.status},
             estimated_hours = ${args.input.estimatedHours},
             estimated_cost = ${args.input.estimatedCost},
             updated_at = now(),
             updated_by = ${args.actorId}
       where id = ${args.taskId}
         and project_id = ${args.projectId}
         and org_id = ${args.orgId}
       returning id, project_id, code, name, status, estimated_hours, estimated_cost, updated_at
    `))
    const after = updated.rows[0]
    if (!after) {
      throw new ProjectWorkBreakdownError(
        'This task changed while you were saving. Refresh and review the latest values.',
        409,
      )
    }
    await recordTaskAudit({
      exec: tx,
      orgId: args.orgId,
      projectId: args.projectId,
      taskId: args.taskId,
      actorId: args.actorId,
      action: 'update',
      before,
      after,
    })
    return clientTask(after)
  })
}
