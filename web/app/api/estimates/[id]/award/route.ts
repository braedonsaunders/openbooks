import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { exactMoney, isoDate, uuidId } from '@/lib/api/json'
import { notFound, unprocessable } from '@/lib/api/responses'
import { can, type Authz } from '@/lib/authz'
import { isFeatureEnabled } from '@/lib/features'
import { awardQuote, previewQuoteAward, QuoteAwardError } from '@openbooks/engine/src/billing/quote-award.ts'
import { AwardPlanError } from '@openbooks/engine/src/projects/award-plan.ts'
import { ProjectCreateError } from '@openbooks/engine/src/projects/project-create.ts'
import { BudgetBaselineError } from '@openbooks/engine/src/projects/budget-baselines.ts'

export const runtime = 'nodejs'

const params = z.object({ id: z.string() })

const awardBody = z.object({
  target: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('new'),
      name: z.string().max(300).nullable().optional(),
      projectTypeId: uuidId.nullable().optional(),
      startsOn: isoDate().nullable().optional(),
      contractValue: z.union([exactMoney(), z.null()]).optional(),
    }).strict(),
    z.object({ mode: z.literal('existing'), projectId: uuidId }).strict(),
  ]),
  tasks: z.array(z.object({
    key: z.string().min(1).max(200),
    code: z.string().max(80).nullable().optional(),
    name: z.string().max(300),
    existingTaskId: uuidId.nullable().optional(),
  }).strict()).max(2000).optional(),
  mapping: z.array(z.object({ lineId: uuidId, taskKey: z.string().max(200) }).strict()).max(5000).optional(),
  lineCosts: z.array(z.object({ lineId: uuidId, cost: exactMoney() }).strict()).max(5000).optional(),
  productionQuantities: z.boolean().optional(),
}).strict()

/** Awarding needs Orders on and the quote readable, beyond the route's Projects gate. */
async function guard(authz: Authz): Promise<NextResponse | null> {
  if (!(await isFeatureEnabled(authz.user.orgId, 'orders'))) return notFound('record')
  if (!can(authz, 'estimates.read')) {
    return NextResponse.json({ error: 'missing permission: estimates.read' }, { status: 403 })
  }
  return null
}

async function refusal(error: unknown): Promise<NextResponse> {
  if (
    (error instanceof QuoteAwardError || error instanceof ProjectCreateError || error instanceof BudgetBaselineError)
    && error.status === 404
  ) {
    return notFound('record')
  }
  if (error instanceof AwardPlanError || error instanceof ProjectCreateError) {
    return unprocessable(error.message, error.field ? { field: error.field } : {})
  }
  return apiErrorResponse(error)
}

function context(authz: Authz) {
  return { orgId: authz.user.orgId, actorId: authz.user.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds }
}

/**
 * Award an issued quote into a project. GET previews the consequence — the
 * default project, its type and contract value, and the tasks, hours, cost
 * and price the quote budgets (pass ?projectId= to plan into one of the
 * customer's existing projects). POST commits it in one idempotent
 * transaction; awarding an already-awarded quote returns its project.
 */
export const GET = defineRoute({
  permission: 'projects.manage',
  feature: 'projects',
  params,
  handler: async ({ request, authz, params: { id } }) => {
    const denied = await guard(authz)
    if (denied) return denied
    try {
      const projectId = new URL(request.url).searchParams.get('projectId')
      return NextResponse.json(await previewQuoteAward(context(authz), id, { projectId }))
    } catch (error) {
      return refusal(error)
    }
  },
})

export const POST = defineRoute({
  permission: 'projects.manage',
  feature: 'projects',
  params,
  body: awardBody,
  handler: async ({ authz, params: { id }, body }) => {
    const denied = await guard(authz)
    if (denied) return denied
    try {
      const result = await awardQuote(context(authz), id, body)
      return NextResponse.json(result, { status: result.created ? 201 : 200 })
    } catch (error) {
      return refusal(error)
    }
  },
})
