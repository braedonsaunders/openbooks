import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { guardProjectSchedulingFeature } from '../../../lib/projects-gate'
import {
  ScheduleError,
  batchUpdateScheduleTasks,
  createScheduleBaseline,
  createScheduleDependency,
  createScheduleTask,
  deleteScheduleBaseline,
  deleteScheduleCalendar,
  deleteScheduleDependency,
  deleteScheduleResource,
  deleteScheduleTask,
  loadProjectSchedule,
  updateScheduleTask,
  upsertScheduleCalendar,
  upsertScheduleResource,
} from '../../../lib/project-schedule'

export const runtime = 'nodejs'

/**
 * The project schedule API.
 *
 * Every entry point resolves the caller's org from the session, checks the
 * Projects → Project Scheduling gate (which fails closed when the parent
 * Projects gate is off), and confirms the project is inside the caller's
 * permitted subsidiaries before touching a row.
 */

type Gate = Exclude<Awaited<ReturnType<typeof guardPermission>>, NextResponse>

/** Resolve + authorize the project, or return the response to send. */
async function resolveProject(gate: Gate, projectId: string | null) {
  if (!projectId || !isUuid(projectId)) {
    return { error: NextResponse.json({ error: 'projectId required' }, { status: 400 }) }
  }
  const project = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from projects
     where id = ${projectId} and org_id = ${gate.user.orgId}`))
  const row = project.rows[0]
  if (!row || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(row.subsidiary_id)))) {
    return { error: NextResponse.json({ error: 'not found' }, { status: 404 }) }
  }
  return { projectId: row.id }
}

function handleError(error: unknown) {
  if (error instanceof ScheduleError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  throw error
}

/** GET ?projectId= — the whole plan. */
export async function GET(req: Request) {
  const gate = await guardPermission('projects.read')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectSchedulingFeature(gate.user.orgId)
  if (feature) return feature

  const resolved = await resolveProject(gate, new URL(req.url).searchParams.get('projectId'))
  if ('error' in resolved) return resolved.error

  return NextResponse.json({ schedule: await loadProjectSchedule(gate.user.orgId, resolved.projectId) })
}

type Body = {
  projectId?: string
  action?: string
  taskId?: string
  id?: string
  patch?: Record<string, unknown>
  updates?: Array<{ id: string } & Record<string, unknown>>
  input?: Record<string, unknown>
}

/**
 * POST — every schedule mutation, dispatched by `action`. One endpoint keeps
 * the project authorization check in a single place instead of repeating it
 * across a dozen routes.
 */
export async function POST(req: Request) {
  const gate = await guardPermission('projects.manage')
  if (gate instanceof NextResponse) return gate
  const feature = await guardProjectSchedulingFeature(gate.user.orgId)
  if (feature) return feature

  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as Body
  const resolved = await resolveProject(gate, body.projectId ?? null)
  if ('error' in resolved) return resolved.error

  const orgId = gate.user.orgId
  const projectId = resolved.projectId
  const userId = gate.user.id ?? null

  try {
    switch (body.action) {
      case 'createTask': {
        const id = await createScheduleTask(
          orgId,
          projectId,
          { name: '', ...(body.input ?? {}) } as never,
          userId,
        )
        return NextResponse.json({ id })
      }
      case 'updateTask': {
        if (!body.taskId || !isUuid(body.taskId)) {
          return NextResponse.json({ error: 'taskId required' }, { status: 400 })
        }
        await updateScheduleTask(orgId, projectId, body.taskId, (body.patch ?? {}) as never, userId)
        return NextResponse.json({ ok: true })
      }
      case 'batchUpdateTasks': {
        const updates = Array.isArray(body.updates) ? body.updates : []
        if (updates.some((update) => !update?.id || !isUuid(String(update.id)))) {
          return NextResponse.json({ error: 'every update needs a task id' }, { status: 400 })
        }
        await batchUpdateScheduleTasks(orgId, projectId, updates as never, userId)
        return NextResponse.json({ ok: true })
      }
      case 'deleteTask': {
        if (!body.taskId || !isUuid(body.taskId)) {
          return NextResponse.json({ error: 'taskId required' }, { status: 400 })
        }
        await deleteScheduleTask(orgId, projectId, body.taskId)
        return NextResponse.json({ ok: true })
      }
      case 'createDependency': {
        const input = (body.input ?? {}) as {
          predecessorId?: string
          successorId?: string
          type?: string
          lagDays?: number
        }
        if (!isUuid(String(input.predecessorId)) || !isUuid(String(input.successorId))) {
          return NextResponse.json({ error: 'predecessor and successor required' }, { status: 400 })
        }
        await createScheduleDependency(orgId, projectId, input as never, userId)
        return NextResponse.json({ ok: true })
      }
      case 'deleteDependency': {
        if (!body.id || !isUuid(body.id)) {
          return NextResponse.json({ error: 'id required' }, { status: 400 })
        }
        await deleteScheduleDependency(orgId, projectId, body.id)
        return NextResponse.json({ ok: true })
      }
      case 'createBaseline': {
        const input = (body.input ?? {}) as { name?: string }
        if (!input.name?.trim()) {
          return NextResponse.json({ error: 'baseline name required' }, { status: 400 })
        }
        await createScheduleBaseline(orgId, projectId, input as never, userId)
        return NextResponse.json({ ok: true })
      }
      case 'deleteBaseline': {
        if (!body.id || !isUuid(body.id)) {
          return NextResponse.json({ error: 'id required' }, { status: 400 })
        }
        await deleteScheduleBaseline(orgId, projectId, body.id)
        return NextResponse.json({ ok: true })
      }
      case 'saveCalendar': {
        const id = await upsertScheduleCalendar(orgId, projectId, (body.input ?? {}) as never, userId)
        return NextResponse.json({ id })
      }
      case 'deleteCalendar': {
        if (!body.id || !isUuid(body.id)) {
          return NextResponse.json({ error: 'id required' }, { status: 400 })
        }
        await deleteScheduleCalendar(orgId, projectId, body.id)
        return NextResponse.json({ ok: true })
      }
      case 'saveResource': {
        const id = await upsertScheduleResource(orgId, projectId, (body.input ?? {}) as never, userId)
        return NextResponse.json({ id })
      }
      case 'deleteResource': {
        if (!body.id || !isUuid(body.id)) {
          return NextResponse.json({ error: 'id required' }, { status: 400 })
        }
        await deleteScheduleResource(orgId, projectId, body.id)
        return NextResponse.json({ ok: true })
      }
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (error) {
    return handleError(error)
  }
}
