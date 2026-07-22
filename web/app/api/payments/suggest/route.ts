import { NextResponse } from 'next/server'
import { suggestApplications } from '@openbooks/engine/src/payments.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { paymentErrorResponse } from '../lib'

export const runtime = 'nodejs'

/** Automated cash application: suggest how an amount settles a party's open items. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    partyId?: string
    amount?: string | number
    side?: string
    currency?: string
    reference?: string | null
  }
  const side = body.side
  if (side !== 'ap' && side !== 'ar') {
    return NextResponse.json({ error: 'side must be ap or ar' }, { status: 400 })
  }
  const gate = await guardPermission(side === 'ap' ? 'ap.pay' : 'ar.pay')
  if (gate instanceof NextResponse) return gate
  if (!body.partyId || !isUuid(body.partyId)) {
    return NextResponse.json({ error: 'partyId is required' }, { status: 400 })
  }
  const amount = String(body.amount ?? '')
  if (amount === '' || Number.isNaN(Number(amount))) {
    return NextResponse.json({ error: 'a numeric amount is required' }, { status: 400 })
  }
  if (!body.currency || !/^[A-Z]{3}$/.test(body.currency)) {
    return NextResponse.json({ error: 'currency is required' }, { status: 400 })
  }
  try {
    const suggestion = await suggestApplications(body.partyId, amount, side, {
      reference: body.reference ?? null,
      sourceCurrency: body.currency,
    })
    return NextResponse.json(suggestion)
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
