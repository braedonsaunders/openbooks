import { z } from 'zod'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { updateInternalBillingRuleVersion } from '@openbooks/engine/internal-billing'

export const runtime = 'nodejs'

const patchBody = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  billableByDefault: z.boolean().nullable().optional(),
  effectiveTo: z.string().nullable().optional(),
  isActive: z.boolean().nullable().optional(),
  reason: z.string(),
}).strict()

/**
 * Change what a version may change — name, description, billable default,
 * the end of its window, active — with a reason. Method, accounts and start
 * date are the version's accounting facts; a new treatment is a new version.
 */
export const PATCH = defineRoute({
  permission: 'admin.setup.manage',
  feature: 'internalBilling',
  scope: 'unrestricted',
  params: z.object({ id: z.string().uuid() }),
  body: patchBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => {
    const { reason, ...patch } = body
    const updated = await updateInternalBillingRuleVersion({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      id: params.id,
      patch: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.billableByDefault != null ? { billableByDefault: patch.billableByDefault } : {}),
        ...(patch.effectiveTo !== undefined ? { effectiveTo: patch.effectiveTo } : {}),
        ...(patch.isActive != null ? { isActive: patch.isActive } : {}),
      },
      reason,
    })
    return NextResponse.json(updated)
  },
})
