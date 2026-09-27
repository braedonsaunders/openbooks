import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json"
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { guardPermission } from '../../../lib/authz'
import { isUuid } from '../../../lib/list-params'
import { canonicalDecimal } from '../../../lib/exact-decimal'
import { moneyRefusal } from '../../../lib/payroll-decimal-refusal'
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
import { notFound } from "@/lib/api/responses";

const project = { projectId: z.string().uuid() }
const taskPatchShape = {
  phaseId: z.string().nullable().optional(),
  calendarId: z.string().uuid().nullable().optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
  outlineLevel: z.number().int().min(0).optional(),
  name: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  taskType: z.enum(['task', 'milestone', 'summary']).optional(),
  status: z.enum(['not_started', 'in_progress', 'complete', 'on_hold']).optional(),
  startDate: z.string().refine(isIsoCalendarDate, 'startDate must be a real calendar date (YYYY-MM-DD)').nullable().optional(),
  endDate: z.string().refine(isIsoCalendarDate, 'endDate must be a real calendar date (YYYY-MM-DD)').nullable().optional(),
  duration: z.number().finite().min(0).optional(),
  progress: z.number().finite().min(0).max(100).optional(),
  assignee: z.string().max(500).optional(),
  order: z.number().int().min(0).optional(),
  constraintType: z.enum(['asap', 'alap', 'snet', 'snlt', 'fnet', 'fnlt', 'mso', 'mfo']).optional(),
  constraintDate: z.string().refine(isIsoCalendarDate, 'constraintDate must be a real calendar date (YYYY-MM-DD)').nullable().optional(),
  deadlineDate: z.string().refine(isIsoCalendarDate, 'deadlineDate must be a real calendar date (YYYY-MM-DD)').nullable().optional(),
  actualStart: z.string().refine(isIsoCalendarDate, 'actualStart must be a real calendar date (YYYY-MM-DD)').nullable().optional(),
  actualEnd: z.string().refine(isIsoCalendarDate, 'actualEnd must be a real calendar date (YYYY-MM-DD)').nullable().optional(),
}
const taskPatch = z.strictObject(taskPatchShape)
const taskCreate = z.strictObject({ ...taskPatchShape, name: z.string().trim().min(1).max(500) })
const dependencyInput = z.strictObject({
  predecessorId: z.string().uuid(),
  successorId: z.string().uuid(),
  type: z.enum(['FS', 'SS', 'FF', 'SF']).optional(),
  lagDays: z.number().int().min(-2147483648).max(2147483647).optional(),
})
const baselineInput = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  kind: z.enum(['primary', 'secondary', 'tertiary', 'snapshot', 'custom']).optional(),
  isPrimary: z.boolean().optional(),
})
const calendarInput = z.strictObject({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  workingDays: z.record(z.string().regex(/^[0-6]$/), z.boolean()).optional(),
  holidays: z.array(z.string().refine(isIsoCalendarDate, 'holiday must be a real calendar date (YYYY-MM-DD)')).optional(),
  isDefault: z.boolean().optional(),
}).refine((input) => Boolean(input.id) || Boolean(input.name), {
  message: 'a calendar name is required when creating a calendar', path: ['name'],
})
const costRate = z.string().superRefine((value, ctx) => {
  if (canonicalDecimal(value, 4) === null) ctx.addIssue({ code: 'custom', message: moneyRefusal('Cost rate', value) })
})
const resourceInput = z.strictObject({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  role: z.string().max(200).optional(),
  kind: z.enum(['labor', 'crew', 'equipment', 'subcontractor']).optional(),
  calendarId: z.string().uuid().nullable().optional(),
  defaultUnits: z.number().finite().positive().optional(),
  capacityPerDay: z.number().finite().positive().optional(),
  costRate: costRate.nullable().optional(),
}).refine((input) => Boolean(input.id) || Boolean(input.name), {
  message: 'a resource name is required when creating a resource', path: ['name'],
})
const requestBodySchema = z.discriminatedUnion('action', [
  z.strictObject({ ...project, action: z.literal('createTask'), input: taskCreate }),
  z.strictObject({ ...project, action: z.literal('updateTask'), taskId: z.string().uuid(), patch: taskPatch }),
  z.strictObject({ ...project, action: z.literal('batchUpdateTasks'), updates: z.array(z.strictObject({ id: z.string().uuid(), ...taskPatchShape })).min(1) }),
  z.strictObject({ ...project, action: z.literal('deleteTask'), taskId: z.string().uuid() }),
  z.strictObject({ ...project, action: z.literal('createDependency'), input: dependencyInput }),
  z.strictObject({ ...project, action: z.literal('deleteDependency'), id: z.string().uuid() }),
  z.strictObject({ ...project, action: z.literal('createBaseline'), input: baselineInput }),
  z.strictObject({ ...project, action: z.literal('deleteBaseline'), id: z.string().uuid() }),
  z.strictObject({ ...project, action: z.literal('saveCalendar'), input: calendarInput }),
  z.strictObject({ ...project, action: z.literal('deleteCalendar'), id: z.string().uuid() }),
  z.strictObject({ ...project, action: z.literal('saveResource'), input: resourceInput }),
  z.strictObject({ ...project, action: z.literal('deleteResource'), id: z.string().uuid() }),
])



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
type ProjectResolution = { error: NextResponse } | { projectId: string }

async function resolveProject(gate: Gate, projectId: string | null): Promise<ProjectResolution> {
  if (!projectId || !isUuid(projectId)) {
    return { error: NextResponse.json({ error: 'projectId required' }, { status: 400 }) }
  }
  const project = (await db.execute<{ id: string; subsidiary_id: string | null }>(sql`
    select id, subsidiary_id from projects
     where id = ${projectId} and org_id = ${gate.user.orgId}`))
  const row = project.rows[0]
  if (!row || (gate.allowedSubsidiaryIds && !gate.allowedSubsidiaryIds.has(String(row.subsidiary_id)))) {
    return { error: notFound("record") }
  }
  return { projectId: row.id }
}

function handleError(error: unknown): Promise<NextResponse> {
  if (error instanceof ScheduleError) {
    return apiErrorResponse(error)
  }
  throw error
}

/** GET ?projectId= — the whole plan. */
export const GET = defineRoute({
  permission: 'projects.read',
  feature: { none: 'No optional feature applies to this permission-governed endpoint.' },
  handler: async ({ request: req, authz: gate }): Promise<NextResponse> => {
    const feature = await guardProjectSchedulingFeature(gate.user.orgId)
    if (feature instanceof NextResponse) return feature

    const resolved = await resolveProject(gate, new URL(req.url).searchParams.get('projectId'))
    if ('error' in resolved) return resolved.error

    return NextResponse.json({
      schedule: await loadProjectSchedule(gate.user.orgId, resolved.projectId, gate.allowedSubsidiaryIds),
    })

  },
})

/**
 * POST — every schedule mutation, dispatched by `action`. One endpoint keeps
 * the project authorization check in a single place instead of repeating it
 * across a dozen routes.
 */
export const POST = defineRoute({
  permission: 'projects.manage',
  feature: { none: 'No optional feature applies to this permission-governed endpoint.' },
  handler: async ({ request: req, authz: gate }): Promise<NextResponse> => {
    const feature = await guardProjectSchedulingFeature(gate.user.orgId)
    if (feature instanceof NextResponse) return feature

    const parsedBody = await parseJsonBody(req, requestBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data
    const resolved = await resolveProject(gate, body.projectId ?? null)
    if ('error' in resolved) return resolved.error

    const orgId = gate.user.orgId
    const projectId = resolved.projectId
    const userId = gate.user.id ?? null

    try {
      switch (body.action) {
        // Every subordinate write re-locks the project and re-asserts scope
        // inside its own transaction (the service takes the caller's scope):
        // the resolveProject pre-read above cannot authorize a project that a
        // concurrent PATCH has since moved to another subsidiary.
        case 'createTask': {
          const id = await createScheduleTask(
            orgId,
            projectId,
            body.input as never,
            userId,
            gate.allowedSubsidiaryIds,
          )
          return NextResponse.json({ id })
        }
        case 'updateTask': {
          if (!body.taskId || !isUuid(body.taskId)) {
            return NextResponse.json({ error: 'taskId required' }, { status: 400 })
          }
          await updateScheduleTask(orgId, projectId, body.taskId, (body.patch ?? {}) as never, userId, gate.allowedSubsidiaryIds)
          return NextResponse.json({ ok: true })
        }
        case 'batchUpdateTasks': {
          const updates = Array.isArray(body.updates) ? body.updates : []
          if (updates.some((update) => !update?.id || !isUuid(String(update.id)))) {
            return NextResponse.json({ error: 'every update needs a task id' }, { status: 400 })
          }
          await batchUpdateScheduleTasks(orgId, projectId, updates as never, userId, gate.allowedSubsidiaryIds)
          return NextResponse.json({ ok: true })
        }
        case 'deleteTask': {
          if (!body.taskId || !isUuid(body.taskId)) {
            return NextResponse.json({ error: 'taskId required' }, { status: 400 })
          }
          await deleteScheduleTask(orgId, projectId, body.taskId, gate.allowedSubsidiaryIds)
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
          await createScheduleDependency(orgId, projectId, input as never, userId, gate.allowedSubsidiaryIds)
          return NextResponse.json({ ok: true })
        }
        case 'deleteDependency': {
          if (!body.id || !isUuid(body.id)) {
            return NextResponse.json({ error: 'id required' }, { status: 400 })
          }
          await deleteScheduleDependency(orgId, projectId, body.id, gate.allowedSubsidiaryIds)
          return NextResponse.json({ ok: true })
        }
        case 'createBaseline': {
          const input = (body.input ?? {}) as { name?: string }
          if (!input.name?.trim()) {
            return NextResponse.json({ error: 'baseline name required' }, { status: 400 })
          }
          await createScheduleBaseline(orgId, projectId, input as never, userId, gate.allowedSubsidiaryIds)
          return NextResponse.json({ ok: true })
        }
        case 'deleteBaseline': {
          if (!body.id || !isUuid(body.id)) {
            return NextResponse.json({ error: 'id required' }, { status: 400 })
          }
          await deleteScheduleBaseline(orgId, projectId, body.id, gate.allowedSubsidiaryIds)
          return NextResponse.json({ ok: true })
        }
        case 'saveCalendar': {
          const id = await upsertScheduleCalendar(orgId, projectId, (body.input ?? {}) as never, userId, gate.allowedSubsidiaryIds)
          return NextResponse.json({ id })
        }
        case 'deleteCalendar': {
          if (!body.id || !isUuid(body.id)) {
            return NextResponse.json({ error: 'id required' }, { status: 400 })
          }
          await deleteScheduleCalendar(orgId, projectId, body.id, gate.allowedSubsidiaryIds)
          return NextResponse.json({ ok: true })
        }
        case 'saveResource': {
          const id = await upsertScheduleResource(orgId, projectId, (body.input ?? {}) as never, userId, gate.allowedSubsidiaryIds)
          return NextResponse.json({ id })
        }
        case 'deleteResource': {
          if (!body.id || !isUuid(body.id)) {
            return NextResponse.json({ error: 'id required' }, { status: 400 })
          }
          await deleteScheduleResource(orgId, projectId, body.id, gate.allowedSubsidiaryIds)
          return NextResponse.json({ ok: true })
        }
        default:
          return NextResponse.json({ error: 'unknown action' }, { status: 400 })
      }
    } catch (error) {
      return handleError(error)
    }

  },
})
