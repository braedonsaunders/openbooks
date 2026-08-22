import { NextResponse } from 'next/server'
import { openItemsForParty } from '@openbooks/engine/src/payments.ts'
import { guardPermission } from '../../../../lib/authz'
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

  try {
    const items = await openItemsForParty(partyId, side, gate.user.orgId)
    return NextResponse.json({ items })
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
