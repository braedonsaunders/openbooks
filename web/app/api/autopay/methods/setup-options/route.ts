import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { isUuid } from '@/lib/list-params'
import { notFound } from '@/lib/api/responses'
import { guardAutopayPartyScope } from '@/lib/autopay-scope'
import { loadSetupLinkOptions } from '@/lib/autopay-setup-link'

export const runtime = 'nodejs'

/**
 * What the Add payment method drawer offers for one customer: the currencies
 * the customer's legal entity may collect in, the providers enabled for
 * online payments, the email addresses on file, and whether the
 * organization can send email at all. The POST re-checks each of these.
 */
export const GET = defineRoute({
  permission: 'payment_methods.manage',
  feature: 'autopay',
  handler: async ({ authz, request }) => {
    const partyId = new URL(request.url).searchParams.get('partyId') ?? ''
    if (!partyId || !isUuid(partyId)) return NextResponse.json({ error: 'partyId is required' }, { status: 400 })
    const outOfScope = await guardAutopayPartyScope(authz, partyId)
    if (outOfScope) return outOfScope
    const options = await loadSetupLinkOptions(authz.user.orgId, partyId)
    if (!options) return notFound('record')
    return NextResponse.json(options)
  },
})
