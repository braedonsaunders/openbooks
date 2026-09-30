import { z } from 'zod'
import { NextResponse } from 'next/server'
import { proposeProvisionAssessment } from '@openbooks/engine/provisions'
import { defineRoute, type PermissionRouteOptions } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { exactMoney, isoDate, uuidId } from '@/lib/api/json'

export const runtime = 'nodejs'
const estimate = z.discriminatedUnion('method', [
  z.object({ method: z.literal('best_estimate'), amount: exactMoney() }).strict(),
  z.object({ method: z.literal('expected_value'), outcomes: z.array(z.object({ amount: exactMoney(), probability: exactMoney() }).strict()).min(1).max(1000) }).strict(),
  z.object({ method: z.literal('uniform_range'), minimum: exactMoney(), maximum: exactMoney() }).strict(),
  z.object({ method: z.literal('no_better_estimate_range'), minimum: exactMoney(), maximum: exactMoney() }).strict(),
])
const bodySchema = z.object({
    obligation: z.object({ id: uuidId, subsidiaryId: uuidId, bookId: uuidId, name: z.string().trim().min(1).max(200), currency: z.string().regex(/^[A-Z]{3}$/), expenseAccountId: uuidId, liabilityAccountId: uuidId }).strict(),
    effectiveOn: isoDate(), reason: z.string().trim().min(8).max(1000), idempotencyKey: z.string().min(1).max(120),
    assessment: z.object({ presentObligation: z.boolean(), outflow: z.enum(['probable', 'possible', 'remote']), reliablyEstimable: z.boolean(), evidence: z.string().trim().min(20).max(10000), discounting: z.enum(['immaterial', 'included_in_estimate', 'undiscounted']), discountEvidence: z.string().trim().min(20).max(10000), estimate: estimate.nullable() }).strict(),
  }).strict()
const options: PermissionRouteOptions<undefined, typeof bodySchema> = {
  permission: 'gl.manage', feature: { none: 'Provision assessment is a core general-ledger obligation control.' }, body: bodySchema,
  handler: async ({ authz, body }) => {
    try { return NextResponse.json({ id: await proposeProvisionAssessment(authz.user.orgId, authz.user.id, body) }, { status: 201 }) }
    catch (error) { return apiErrorResponse(error) }
  },
}
export const POST = defineRoute(options)
