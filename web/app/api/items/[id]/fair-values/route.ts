import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { canonicalDecimal, isPositiveDecimal } from '../../../../../lib/exact-decimal'

export const runtime = 'nodejs'

/**
 * Fair-value / standalone selling prices (fair_value_prices) for one item —
 * dated, per-currency SSPs used to allocate bundle revenue across obligations
 * (relative-SSP, ASC 606). Re-homed from the Setup workspace onto the item
 * record, so it is gated by the item permissions and the Revenue Recognition
 * Features switch (same key as the setup entity). GET lists; POST/PATCH/DELETE
 * mutate a single dated row.
 */

async function itemExists(id: string, orgId: string) {
  const r = (await db.execute(sql`select 1 from items where id = ${id} and org_id = ${orgId}`)) as any
  return Boolean(r.rows[0])
}

function money(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null
  return canonicalDecimal(value, 4)
}

function dateOrNull(value: unknown): string | null {
  const s = String(value ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.read', 'revenueRecognition')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id) || !(await itemExists(id, gate.user.orgId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const rows = (await db.execute(sql`
    select id, currency, unit_price, low_value, high_value, effective_from, effective_to, is_active
      from fair_value_prices
     where org_id = ${gate.user.orgId} and item_id = ${id}
     order by currency, effective_from desc nulls last`)) as any
  return NextResponse.json({ prices: rows.rows })
}

/** Shared field extraction/validation for POST and PATCH. */
function parseBody(body: Record<string, unknown>): { error: string } | {
  currency: string; unitPrice: string; lowValue: string | null; highValue: string | null
  effectiveFrom: string | null; effectiveTo: string | null; isActive: boolean
} {
  const currency = String(body.currency ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) return { error: 'Currency must be a three-letter code' }
  const unitPrice = money(body.unitPrice)
  if (unitPrice === null || !isPositiveDecimal(unitPrice)) return { error: 'Enter a unit price greater than zero' }
  const effectiveFrom = dateOrNull(body.effectiveFrom)
  const effectiveTo = dateOrNull(body.effectiveTo)
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
    return { error: 'The end date cannot precede the start date' }
  }
  return {
    currency, unitPrice, lowValue: money(body.lowValue), highValue: money(body.highValue),
    effectiveFrom, effectiveTo, isActive: body.isActive === undefined ? true : Boolean(body.isActive),
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.manage', 'revenueRecognition')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const { id } = await params
  if (!isUuid(id) || !(await itemExists(id, orgId))) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const parsed = parseBody((await req.json().catch(() => ({}))) as Record<string, unknown>)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const inserted = (await db.execute(sql`
    insert into fair_value_prices
      (org_id, item_id, currency, unit_price, low_value, high_value, effective_from, effective_to, is_active, created_by, updated_by)
    values
      (${orgId}, ${id}, ${parsed.currency}, ${parsed.unitPrice}, ${parsed.lowValue}, ${parsed.highValue},
       ${parsed.effectiveFrom}, ${parsed.effectiveTo}, ${parsed.isActive}, ${actorId}, ${actorId})
    returning id`)) as any
  return NextResponse.json({ id: inserted.rows[0].id })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.manage', 'revenueRecognition')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const rowId = String(body.id ?? '')
  if (!isUuid(rowId)) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const parsed = parseBody(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const updated = (await db.execute(sql`
    update fair_value_prices set
      currency = ${parsed.currency}, unit_price = ${parsed.unitPrice},
      low_value = ${parsed.lowValue}, high_value = ${parsed.highValue},
      effective_from = ${parsed.effectiveFrom}, effective_to = ${parsed.effectiveTo},
      is_active = ${parsed.isActive}, updated_at = now(), updated_by = ${actorId}
     where id = ${rowId} and item_id = ${id} and org_id = ${orgId}
    returning id`)) as any
  if (!updated.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ id: rowId })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.manage', 'revenueRecognition')
  if (gate instanceof NextResponse) return gate
  const { orgId } = gate.user
  const { id } = await params
  const rowId = new URL(req.url).searchParams.get('id') ?? ''
  if (!isUuid(rowId)) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const deleted = (await db.execute(sql`
    delete from fair_value_prices where id = ${rowId} and item_id = ${id} and org_id = ${orgId}
    returning id`)) as any
  if (!deleted.rows.length) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
