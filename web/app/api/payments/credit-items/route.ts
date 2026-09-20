import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { creditItemsForParty } from '@openbooks/engine/src/payments/payments.ts'
import { paymentErrorResponse } from '../lib'
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

export const runtime = 'nodejs'

/**
 * Posted, still-open credit-memo lines a receipt can apply: the mirror of
 * open-items, which lists only the debit items a payment extinguishes.
 * Credits carry the opposite sign and are consumed from the from_line side,
 * so they need their own reader — without it a posted credit memo is
 * invisible to every receipt flow.
 */
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
  // (mirrors the party lists and the open-items reader).
  const party = (await db.execute<{ subsidiaryId: string | null }>(sql`
    select subsidiary_id as "subsidiaryId" from parties
     where id = ${partyId} and org_id = ${gate.user.orgId}
  `))
  if (!party.rows[0]) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const scopeDenied = guardSubsidiaryScope(gate, party.rows[0].subsidiaryId, { orgWideNull: true })
  if (scopeDenied) return scopeDenied

  try {
    const items = await creditItemsForParty(partyId, side, gate.user.orgId, gate.allowedSubsidiaryIds)
    return NextResponse.json({ items })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
