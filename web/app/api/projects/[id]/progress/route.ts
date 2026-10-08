import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { isUuid } from '../../../../../lib/list-params'
import { progressErrorResponse } from '../../../../../lib/project-progress-api'
import { listProgress, recordProgress, reverseProgress } from '@openbooks/engine/src/projects/progress.ts'

const params = z.object({ id: z.string() })
const progressBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('record'),
    taskId: z.string().uuid(),
    entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    quantity: z.string().min(1).max(40),
    unit: z.string().min(1).max(32),
    note: z.string().max(500).nullable().optional(),
  }).strict(),
  z.object({
    action: z.literal('reverse'),
    entryId: z.string().uuid(),
    reason: z.string().min(1).max(500),
  }).strict(),
])

/** Installed-quantity history for a project, optionally one task, newest first. */
export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'projectProgress',
  params,
  handler: async ({ request, authz, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    const taskId = new URL(request.url).searchParams.get('taskId')
    if (taskId !== null && !isUuid(taskId)) return notFound('record')
    try {
      return NextResponse.json({
        entries: await listProgress({
          orgId: authz.user.orgId,
          projectId: id,
          taskId,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
        }),
      })
    } catch (error) {
      return progressErrorResponse(error)
    }
  },
})

/** Record installed quantity, or reverse a manual entry with an exact negation. */
export const POST = defineRoute({
  permission: 'projects.manage',
  feature: 'projectProgress',
  params,
  body: progressBody,
  handler: async ({ authz, params: { id }, body }) => {
    if (!isUuid(id)) return notFound('record')
    try {
      const entry = body.action === 'record'
        ? await recordProgress({
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            projectId: id,
            taskId: body.taskId,
            entryDate: body.entryDate,
            quantity: body.quantity,
            unit: body.unit,
            note: body.note ?? null,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
          })
        : await reverseProgress({
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            projectId: id,
            entryId: body.entryId,
            reason: body.reason,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
          })
      return NextResponse.json({ entry }, { status: 201 })
    } catch (error) {
      return progressErrorResponse(error)
    }
  },
})
