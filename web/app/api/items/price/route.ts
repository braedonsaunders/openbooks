import { NextResponse } from 'next/server'
import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { guardPermission } from '@/lib/authz'
import { isUuid } from '@/lib/list-params'
import { canonicalDecimal } from '@/lib/exact-decimal'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { resolveItemPrice } from '@/lib/item-pricing'
import { cmp } from '@openbooks/engine/src/money/money.ts'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  const gate = await guardPermission('ar.read')
  if (gate instanceof NextResponse) return gate
  const parsed = await parseJsonBody(request, jsonObject)
  if (!parsed.ok) return parsed.response
  const body = parsed.data as Record<string, unknown>
  const itemId = String(body.itemId ?? '')
  const customerId = body.customerId == null || body.customerId === '' ? null : String(body.customerId)
  const currency = String(body.currency ?? '').trim().toUpperCase()
  const onDate = String(body.onDate ?? '')
  const lineQuantity = canonicalDecimal(body.lineQuantity, 4)
  const overallItemQuantity = canonicalDecimal(body.overallItemQuantity ?? body.lineQuantity, 4)
  if (!isUuid(itemId) || (customerId !== null && !isUuid(customerId))) return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (!/^[A-Z]{3}$/.test(currency)) return NextResponse.json({ error: 'Currency must be a three-letter code' }, { status: 400 })
  if (!isIsoCalendarDate(onDate)) return NextResponse.json({ error: 'Pricing date must be a real calendar date (YYYY-MM-DD)' }, { status: 400 })
  if (lineQuantity === null || overallItemQuantity === null || cmp(lineQuantity, '0') <= 0 || cmp(overallItemQuantity, '0') <= 0) return NextResponse.json({ error: 'Pricing quantities must be greater than zero' }, { status: 400 })
  try {
    const price = await resolveItemPrice({ orgId: gate.user.orgId, itemId, customerId, currency, onDate, lineQuantity, overallItemQuantity })
    return NextResponse.json({ price })
  } catch {
    return NextResponse.json({ error: 'The item price could not be resolved' }, { status: 500 })
  }
}
