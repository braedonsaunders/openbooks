import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { openItemsForParty } from "@openbooks/engine/src/payments/payment-queries.ts";
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { paymentErrorResponse } from '../lib'
import { notFound } from "@/lib/api/responses";
import { defineRoute } from '@/lib/api/route'


export const runtime = 'nodejs'

/** Open AP or AR items for a party, with applied-to-date and open balances. */
async function listOpenItems(req: Request) {
  const url = new URL(req.url)
  const partyId = url.searchParams.get('partyId') ?? ''
  const side = url.searchParams.get('side')
  if (side !== 'ap' && side !== 'ar') {
    return NextResponse.json({ error: 'side must be ap or ar' }, { status: 400 })
  }
  const gate = await guardPermission(side === 'ap' ? 'ap.pay' : 'ar.pay')
  if (gate instanceof NextResponse) return gate
  if (!isUuid(partyId)) return NextResponse.json({ error: 'partyId is required' }, { status: 400 })
  // The party is the record boundary; null-subsidiary parties are org-wide
  // (mirrors the party lists).
  const party = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from parties
     where id = ${partyId} and org_id = ${gate.user.orgId}
  `))
  if (!party.rows[0]) return notFound("record")
  const scopeDenied = guardSubsidiaryScope(gate, party.rows[0].subsidiaryId, { orgWideNull: true })
  if (scopeDenied) return scopeDenied

  try {
    const items = await openItemsForParty(partyId, side, gate.user.orgId, gate.allowedSubsidiaryIds)
    return NextResponse.json({ items })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}

export const GET = defineRoute({
  authorize: async ({ request }) => {
    const side = new URL(request.url).searchParams.get('side')
    if (side !== 'ap' && side !== 'ar') return NextResponse.json({ error: 'side must be ap or ar' }, { status: 400 })
    return guardPermission(side === 'ap' ? 'ap.pay' : 'ar.pay')
  },
  feature: { none: 'Open items require the payment permission matching their AP or AR side.' },
  handler: async ({ request }) => listOpenItems(request),
})
