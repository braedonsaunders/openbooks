import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

export const runtime = 'nodejs'

/**
 * GET /api/stored-value/customer-credits?partyId= — the customer's
 * available store credit per account (id, masked code, currency, exact
 * decimal balance). Feeds the receipt tender picker; redemption itself
 * happens through the payment draft, which re-verifies everything.
 */
export const GET = defineRoute({
  permission: 'stored_value.read',
  feature: 'storedValue',
  handler: async ({ request, authz }) => {
    const url = new URL(request.url)
    const partyId = url.searchParams.get('partyId') ?? ''
    if (!isUuid(partyId)) return NextResponse.json({ error: 'partyId is required' }, { status: 400 })
    const party = (await db.execute<{ subsidiaryId: string | null }>(sql`
      select subsidiary_id as "subsidiaryId" from parties
       where id = ${partyId} and org_id = ${authz.user.orgId}
    `))
    if (!party.rows[0]) return notFound('record')
    const scopeDenied = guardSubsidiaryScope(authz, party.rows[0].subsidiaryId, { orgWideNull: true })
    if (scopeDenied) return scopeDenied
    const credits = (await db.execute<{
      accountId: string; codeLast4: string; currency: string; balance: string
    }>(sql`
      select id as "accountId", code_last4 as "codeLast4", currency,
             (balance_minor::numeric / 10000)::text as balance
        from stored_value_accounts
       where org_id = ${authz.user.orgId} and customer_party_id = ${partyId}
         and status in ('active', 'frozen') and balance_minor > 0
       order by currency, code_last4
    `)).rows
    return NextResponse.json({ credits })
  },
})
