import { defineRoute } from "@/lib/api/route";
import { exactMoney, uuidId, nullableExactMoney } from "@/lib/api/json";
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { isUuid } from '../../../../../lib/list-params'
import { normalizeMoney, wholeDigits } from '@openbooks/engine/money'
import { canonicalDecimal, isPositiveDecimal } from '../../../../../lib/exact-decimal'
import { moneyRefusal } from '../../../../../lib/payroll-decimal-refusal'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { auditSetupChange } from '../../../../../lib/setup/audit'
import { notFound } from "@/lib/api/responses";
import { organizationCurrencyOptions } from '@openbooks/engine/organization/currencies'


const itemParams = z.object({ id: uuidId })
const fairValueCreateBody = z.object({
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/), unitPrice: exactMoney(),
  lowValue: nullableExactMoney().optional(), highValue: nullableExactMoney().optional(),
  effectiveFrom: z.string().nullable().optional(), effectiveTo: z.string().nullable().optional(), isActive: z.boolean().optional(),
})
const fairValueUpdateBody = fairValueCreateBody.extend({ id: uuidId })

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
  const r = ((await db.execute(sql`select 1 from items where id = ${id} and org_id = ${orgId}`)))
  return Boolean(r.rows[0])
}

function money(value: unknown): string | null | 'range' | 'unreadable' {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return 'unreadable'
  if (wholeDigits(exact) > 15) return 'range'
  return normalizeMoney(exact)
}

function dateOrNull(value: unknown): string | null | 'invalid' {
  const s = String(value ?? '').trim()
  if (!s) return null
  // A shape-valid non-day such as February 30 would otherwise reach the DATE
  // columns and surface as a 500 from PostgreSQL instead of failing closed
  // here. Non-date text keeps its existing lenient-null behavior.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  return isIsoCalendarDate(s) ? s : 'invalid'
}

export const GET = defineRoute({ permission: 'items.read', feature: 'revenueRecognition', params: itemParams, handler: async ({ params: { id }, authz: gate }) => {
  if (!isUuid(id) || !(await itemExists(id, gate.user.orgId))) {
    return notFound("record")
  }
  const rows = ((await db.execute(sql`
    select id, currency, unit_price, low_value, high_value, effective_from, effective_to, is_active
      from fair_value_prices
     where org_id = ${gate.user.orgId} and item_id = ${id}
     order by currency, effective_from desc nulls last`)))
  // The picker offers the organization's enabled currencies, once each.
  const seen = new Set<string>()
  const currencies = (await organizationCurrencyOptions(db, gate.user.orgId, gate.allowedSubsidiaryIds))
    .filter((option) => (seen.has(option.value) ? false : (seen.add(option.value), true)))
    .map(({ value, label }) => ({ value, label }))
  return NextResponse.json({ prices: rows.rows, currencies })
} })

/** Shared field extraction/validation for POST and PATCH. */
function parseBody(body: Record<string, unknown>): { error: string } | {
  currency: string; unitPrice: string; lowValue: string | null; highValue: string | null
  effectiveFrom: string | null; effectiveTo: string | null; isActive: boolean
} {
  const currency = String(body.currency ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) return { error: 'Currency must be a three-letter code' }
  const unitPrice = money(body.unitPrice)
  if (unitPrice === 'range') return { error: 'Unit price is out of range — at most 15 whole digits fit the ledger' }
  if (unitPrice === 'unreadable') return { error: moneyRefusal('Unit price', body.unitPrice) }
  if (unitPrice === null || !isPositiveDecimal(unitPrice)) return { error: 'Enter a unit price greater than zero' }
  const lowValue = money(body.lowValue)
  if (lowValue === 'range') return { error: 'Low value is out of range — at most 15 whole digits fit the ledger' }
  if (lowValue === 'unreadable') return { error: moneyRefusal('Low value', body.lowValue) }
  const highValue = money(body.highValue)
  if (highValue === 'range') return { error: 'High value is out of range — at most 15 whole digits fit the ledger' }
  if (highValue === 'unreadable') return { error: moneyRefusal('High value', body.highValue) }
  const effectiveFrom = dateOrNull(body.effectiveFrom)
  const effectiveTo = dateOrNull(body.effectiveTo)
  if (effectiveFrom === 'invalid' || effectiveTo === 'invalid') {
    return { error: 'Enter a real calendar date (YYYY-MM-DD)' }
  }
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    return { error: 'isActive must be a boolean' }
  }
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
    return { error: 'The end date cannot precede the start date' }
  }
  return {
    currency, unitPrice, lowValue, highValue,
    effectiveFrom, effectiveTo, isActive: body.isActive === undefined ? true : body.isActive === true,
  }
}

export const POST = defineRoute({
  permission: 'items.manage', feature: 'revenueRecognition', scope: 'unrestricted', params: itemParams, body: fairValueCreateBody,
  handler: async ({ params: { id }, body, authz: gate }) => {
  const { orgId, id: actorId } = gate.user
  if (!isUuid(id) || !(await itemExists(id, orgId))) {
    return notFound("record")
  }
  const parsed = parseBody(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const created = await db.transaction(async (tx) => {
    const row = (await tx.execute<Record<string, unknown>>(sql`
      insert into fair_value_prices
        (org_id, item_id, currency, unit_price, low_value, high_value, effective_from, effective_to, is_active, created_by, updated_by)
      values
        (${orgId}, ${id}, ${parsed.currency}, ${parsed.unitPrice}, ${parsed.lowValue}, ${parsed.highValue},
         ${parsed.effectiveFrom}, ${parsed.effectiveTo}, ${parsed.isActive}, ${actorId}, ${actorId})
      returning *
    `))
    const createdRow = row.rows[0]!
    await auditSetupChange({
      orgId,
      table: 'fair_value_prices',
      rowId: String(createdRow.id),
      action: 'insert',
      changes: { after: createdRow },
      actorId,
    }, tx)
    return createdRow
  })
  return NextResponse.json({ id: String(created.id) })
  },
})

export const PATCH = defineRoute({
  permission: 'items.manage', feature: 'revenueRecognition', scope: 'unrestricted', params: itemParams, body: fairValueUpdateBody,
  handler: async ({ params: { id }, body, authz: gate }) => {
  const { orgId, id: actorId } = gate.user
  if (!isUuid(id)) return notFound("record")
  const rowId = String(body.id ?? '')
  if (!isUuid(rowId)) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const parsed = parseBody(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  let recordMissing = false
  await db.transaction(async (tx) => {
    const before = ((await tx.execute(sql`
      select * from fair_value_prices where id = ${rowId} and item_id = ${id} and org_id = ${orgId}
      for update
    `)))
    if (!before.rows[0]) {
      recordMissing = true
      return
    }
    const updated = ((await tx.execute(sql`
      update fair_value_prices set
        currency = ${parsed.currency}, unit_price = ${parsed.unitPrice},
        low_value = ${parsed.lowValue}, high_value = ${parsed.highValue},
        effective_from = ${parsed.effectiveFrom}, effective_to = ${parsed.effectiveTo},
        is_active = ${parsed.isActive}, updated_at = now(), updated_by = ${actorId}
       where id = ${rowId} and item_id = ${id} and org_id = ${orgId}
      returning *
    `)))
    await auditSetupChange({
      orgId,
      table: 'fair_value_prices',
      rowId,
      action: 'update',
      changes: { before: before.rows[0], after: updated.rows[0] },
      actorId,
    }, tx)
  })
  if (recordMissing) return notFound("record")
  return NextResponse.json({ id: rowId })
  },
})

export const DELETE = defineRoute({
  permission: 'items.manage', feature: 'revenueRecognition', scope: 'unrestricted', params: itemParams,
  handler: async ({ request: req, params: { id }, authz: gate }) => {
  const { orgId, id: actorId } = gate.user
  if (!isUuid(id)) return notFound("record")
  const rowId = new URL(req.url).searchParams.get('id') ?? ''
  if (!isUuid(rowId)) return NextResponse.json({ error: 'id required' }, { status: 400 })
  let recordMissing = false
  await db.transaction(async (tx) => {
    const existing = ((await tx.execute(sql`
      select * from fair_value_prices where id = ${rowId} and item_id = ${id} and org_id = ${orgId}
      for update
    `)))
    if (!existing.rows[0]) {
      recordMissing = true
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
  if (recordMissing) return notFound("record")
  return NextResponse.json({ ok: true })
  },
})
