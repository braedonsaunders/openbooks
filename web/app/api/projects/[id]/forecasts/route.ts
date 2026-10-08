import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { notFound } from '@/lib/api/responses'
import { isUuid } from '../../../../../lib/list-params'
import { progressErrorResponse } from '../../../../../lib/project-progress-api'
import { listForecasts, recordForecast } from '@openbooks/engine/src/projects/forecasts.ts'

const params = z.object({ id: z.string() })
const forecastBody = z.object({
  taskId: z.string().uuid(),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(['manual', 'remaining_budget', 'units_productivity', 'cost_performance']),
  costToComplete: z.string().max(40).nullable().optional(),
  hoursToComplete: z.string().max(40).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
}).strict()

/** Estimate-to-complete history for one task, newest first. */
export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'projectProgress',
  params,
  handler: async ({ request, authz, params: { id } }) => {
    if (!isUuid(id)) return notFound('record')
    const taskId = new URL(request.url).searchParams.get('taskId')
    if (!taskId || !isUuid(taskId)) return notFound('record')
    try {
      return NextResponse.json({
        forecasts: await listForecasts({
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

/**
 * Record an estimate to complete: a manual figure, or a suggested method the
 * server recomputes for the date and records as that method.
 */
export const POST = defineRoute({
  permission: 'projects.manage',
  feature: 'projectProgress',
  params,
  body: forecastBody,
  handler: async ({ authz, params: { id }, body }) => {
    if (!isUuid(id)) return notFound('record')
    try {
      const forecast = await recordForecast({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        projectId: id,
        taskId: body.taskId,
        asOfDate: body.asOfDate,
        method: body.method,
        costToComplete: body.costToComplete ?? null,
        hoursToComplete: body.hoursToComplete ?? null,
        note: body.note ?? null,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds ?? null,
      })
      return NextResponse.json({ forecast }, { status: 201 })
    } catch (error) {
      return progressErrorResponse(error)
    }
  },
})
