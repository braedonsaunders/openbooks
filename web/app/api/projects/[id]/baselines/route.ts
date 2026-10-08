import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { notFound } from '@/lib/api/responses'
import { isFeatureEnabled } from '@/lib/features'
import {
  BudgetBaselineError,
  captureBudgetBaseline,
  listBudgetBaselines,
} from '@openbooks/engine/src/projects/budget-baselines.ts'

export const runtime = 'nodejs'

const params = z.object({ id: z.string() })
const captureBody = z.object({
  reason: z.string(),
  label: z.string().nullable().optional(),
}).strict()

async function refusal(error: unknown): Promise<NextResponse> {
  if (error instanceof BudgetBaselineError && error.status === 404) return notFound('record')
  return apiErrorResponse(error)
}

/**
 * Budget baselines of one project: GET lists them (oldest first) with whether
 * production quantities are in use; POST snapshots the current work
 * breakdown — the original budget the first time, a revised baseline after.
 */
export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'projects',
  params,
  handler: async ({ authz, params: { id } }) => {
    try {
      const baselines = await listBudgetBaselines(authz.user.orgId, id, authz.allowedSubsidiaryIds)
      return NextResponse.json({
        baselines,
        productionQuantities: await isFeatureEnabled(authz.user.orgId, 'projectProgress'),
      })
    } catch (error) {
      return refusal(error)
    }
  },
})

export const POST = defineRoute({
  permission: 'projects.manage',
  feature: 'projects',
  params,
  body: captureBody,
  handler: async ({ authz, params: { id }, body }) => {
    try {
      const baseline = await captureBudgetBaseline(
        { orgId: authz.user.orgId, actorId: authz.user.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
        { projectId: id, reason: body.reason, label: body.label ?? null },
      )
      return NextResponse.json({ baseline }, { status: 201 })
    } catch (error) {
      return refusal(error)
    }
  },
})
