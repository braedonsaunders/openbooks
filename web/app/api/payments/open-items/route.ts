import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { openItemsForParty } from '@openbooks/engine/src/payments.ts'
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { paymentErrorResponse } from '../lib'

export const runtime = 'nodejs'

/** Open AP or AR items for a party, with applied-to-date and open balances. */
export async function GET(req: Request) {
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
  if (!party.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const scopeDenied = guardSubsidiaryScope(gate, party.rows[0].subsidiaryId, { orgWideNull: true })
  if (scopeDenied) return scopeDenied

  try {
    const items = await openItemsForParty(partyId, side, gate.user.orgId, gate.allowedSubsidiaryIds)
    return NextResponse.json({ items })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
