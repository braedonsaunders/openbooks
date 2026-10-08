import { NextResponse } from 'next/server'
import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'
import { loadPartyDebitMandates } from '@/lib/party-debit-mandates'
import { notFound } from '@/lib/api/responses'

export const runtime = 'nodejs'

/**
 * Debit mandates for one counterparty, plus the bank accounts a new mandate
 * may reference. Reads ride the same grant the mandate write routes
 * (`/api/admin/payment-operations/mandates`) enforce, and the party must sit
 * inside the viewer's subsidiary scope (null-subsidiary parties are
 * org-wide), so the read never reveals a mandate the viewer could not edit.
 * Only active, approved bank accounts are offered, matching the write
 * route's own refusal for any other account.
 */
export const GET = defineRoute({
  permission: 'admin.setup.manage',
  feature: { none: 'Debit mandates are payment-operations configuration with no feature switch of their own; the write routes are ungated the same way.' },
  params: z.object({ id: z.string() }),
  handler: async ({ authz, params }) => {
    const { id: partyId } = params
    if (!isUuid(partyId)) return notFound('record')
    const result = await loadPartyDebitMandates(authz.user.orgId, partyId, authz.allowedSubsidiaryIds)
    if (!result) return notFound('record')
    return NextResponse.json(result)
  },
})
