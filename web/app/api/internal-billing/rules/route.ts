import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import {
  createInternalBillingRuleVersion,
  listInternalBillingRules,
} from '@openbooks/engine/internal-billing'

export const runtime = 'nodejs'

const createBody = z.object({
  code: z.string(),
  name: z.string(),
  method: z.enum(['revenue_credit', 'cost_transfer', 'intercompany_sale']),
  debitAccountId: z.string().uuid(),
  creditAccountId: z.string().uuid(),
  billableByDefault: z.boolean().nullable().optional(),
  description: z.string().nullable().optional(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable().optional(),
  reason: z.string(),
}).strict()

/** Every rule version: the document form picks the one in effect. */
export const GET = defineRoute({
  permission: 'gl.read',
  feature: 'internalBilling',
  handler: async ({ authz }) => NextResponse.json({ rules: await listInternalBillingRules(authz.user.orgId) }),
})

/** Add a rule version; the version in effect before it closes the day before it starts. */
export const POST = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'internalBilling',
  scope: 'unrestricted',
  body: createBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const { reason, ...rule } = body
    const created = await createInternalBillingRuleVersion({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      rule: { ...rule, billableByDefault: rule.billableByDefault === true },
      reason,
    })
    return NextResponse.json(created, { status: 201 })
  },
})
