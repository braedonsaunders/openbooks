import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { normalizeMoney } from '@openbooks/engine/src/money.ts'
import { canonicalDecimal, isPositiveDecimal } from '../../../../../lib/exact-decimal'
import { auditSetupChange } from '../../../../../lib/setup/audit'

export const runtime = 'nodejs'

/**
 * Fair-value / standalone selling prices (fair_value_prices) for one item —
 * dated, per-currency SSPs used to allocate bundle revenue across obligations
 * (relative-SSP, ASC 606). Re-homed from the Setup workspace onto the item
 * record, so it is gated by the item permissions and the Revenue Recognition
 * Features switch (same key as the setup entity). GET lists; POST/PATCH/DELETE
 * mutate a single dated row.
 *
 * Every mutation is audited through the ONE Setup-registry writer
 * (auditSetupChange) in the same transaction — the same trail a save through
 * the registry route would leave, never a parallel format.
 */

async function itemExists(id: string, orgId: string) {
  const r = (await db.execute(sql`select 1 from items where id = ${id} and org_id = ${orgId}`)) as any
  return Boolean(r.rows[0])
}

function money(value: unknown): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const exact = canonicalDecimal(value, 4)
  return exact === null ? null : normalizeMoney(exact)
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
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const parsed = parseBody((parsedBody.data) as Record<string, unknown>)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const created = await db.transaction(async (tx) => {
    const row = (await tx.execute<Record<string, unknown>>(sql`
      insert into fair_value_prices
        (org_id, item_id, currency, unit_price, low_value, high_value, effective_from, effective_to, is_active, created_by, updated_by)
      values
        (${orgId}, ${id}, ${parsed.currency}, ${parsed.unitPrice}, ${parsed.lowValue}, ${parsed.highValue},
         ${parsed.effectiveFrom}, ${parsed.effectiveTo}, ${parsed.isActive}, ${actorId}, ${actorId})
      returning *
    `)) as any
    await auditSetupChange({
      orgId,
      table: 'fair_value_prices',
      rowId: String(row.rows[0].id),
      action: 'insert',
      changes: { after: row.rows[0] },
      actorId,
    }, tx)
    return row.rows[0] as Record<string, unknown>
  })
  return NextResponse.json({ id: String(created.id) })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.manage', 'revenueRecognition')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const { id } = await params
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = (parsedBody2.data) as Record<string, unknown>
  const rowId = String(body.id ?? '')
  if (!isUuid(rowId)) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const parsed = parseBody(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  let notFound = false
  await db.transaction(async (tx) => {
    const before = (await tx.execute(sql`
      select * from fair_value_prices where id = ${rowId} and item_id = ${id} and org_id = ${orgId}
    `)) as any
    if (!before.rows[0]) {
      notFound = true
      return
    }
    const updated = (await tx.execute(sql`
      update fair_value_prices set
        currency = ${parsed.currency}, unit_price = ${parsed.unitPrice},
        low_value = ${parsed.lowValue}, high_value = ${parsed.highValue},
        effective_from = ${parsed.effectiveFrom}, effective_to = ${parsed.effectiveTo},
        is_active = ${parsed.isActive}, updated_at = now(), updated_by = ${actorId}
       where id = ${rowId} and item_id = ${id} and org_id = ${orgId}
      returning *
    `)) as any
    await auditSetupChange({
      orgId,
      table: 'fair_value_prices',
      rowId,
      action: 'update',
      changes: { before: before.rows[0], after: updated.rows[0] },
      actorId,
    }, tx)
  })
  if (notFound) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ id: rowId })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('items.manage', 'revenueRecognition')
  if (gate instanceof NextResponse) return gate
  const { orgId, id: actorId } = gate.user
  const { id } = await params
  const rowId = new URL(req.url).searchParams.get('id') ?? ''
  if (!isUuid(rowId)) return NextResponse.json({ error: 'id required' }, { status: 400 })
  let notFound = false
  await db.transaction(async (tx) => {
    const existing = (await tx.execute(sql`
      select * from fair_value_prices where id = ${rowId} and item_id = ${id} and org_id = ${orgId}
    `)) as any
    if (!existing.rows[0]) {
      notFound = true
      return
    }
    await tx.execute(sql`
      delete from fair_value_prices where id = ${rowId} and item_id = ${id} and org_id = ${orgId}
    `)
    await auditSetupChange({
      orgId,
      table: 'fair_value_prices',
      rowId,
      action: 'delete',
      changes: { before: existing.rows[0] },
      actorId,
    }, tx)
  })
  if (notFound) return NextResponse.json({ error: 'not found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
