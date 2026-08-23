import { NextResponse } from 'next/server'
import { z } from 'zod'
import { suggestApplications } from '@openbooks/engine/src/payments.ts'
import { guardPermission } from '../../../../lib/authz'
import { exactMoney, parseJsonBody, uuidId } from '../../../../lib/api/json'
import { paymentErrorResponse } from '../lib'

export const runtime = 'nodejs'

const suggestBody = z.object({
  partyId: z
    .string({ error: 'partyId is required' })
    .refine((v) => uuidId.safeParse(v).success, 'partyId is required'),
  amount: exactMoney('a numeric amount is required'),
  side: z.enum(['ap', 'ar'], { error: 'side must be ap or ar' }),
  currency: z
    .string({ error: 'currency is required' })
    .regex(/^[A-Z]{3}$/, 'currency is required'),
  reference: z.string().nullable().optional(),
})

/** Automated cash application: suggest how an amount settles a party's open items. */
export async function POST(req: Request) {
  const parsed = await parseJsonBody(req, suggestBody)
  if (!parsed.ok) return parsed.response
  const body = parsed.data
  const gate = await guardPermission(body.side === 'ap' ? 'ap.pay' : 'ar.pay')
  if (gate instanceof NextResponse) return gate
  try {
    const suggestion = await suggestApplications(body.partyId, body.amount, body.side, {
      reference: body.reference ?? null,
      sourceCurrency: body.currency,
    })
    return NextResponse.json(suggestion)
  } catch (e) {
    return paymentErrorResponse(e)
  }
}
