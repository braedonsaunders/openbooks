import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { saveInternalBillingDraft } from '@openbooks/engine/internal-billing'
import { internalBillingBody } from './_schema'

export const runtime = 'nodejs'

/** Create an internal billing draft under the rule version in effect on its date. */
export const POST = defineRoute({
  permission: 'gl.post',
  feature: 'internalBilling',
  body: internalBillingBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const saved = await saveInternalBillingDraft({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      input: body,
    })
    return NextResponse.json(saved, { status: 201 })
  },
})
