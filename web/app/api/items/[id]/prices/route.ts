import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { guardPermission } from '@/lib/authz'
import { jsonObject, parseJsonBody } from '@/lib/api/json'
import { isUuid } from '@/lib/list-params'
import { canonicalDecimal } from '@/lib/exact-decimal'
import { isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { normalizeMoney, cmp } from '@openbooks/engine/src/money/money.ts'
import { auditSetupChange } from '@/lib/setup/audit'
import { claimIdempotentCreate, resolveIdempotentReplay } from '@/lib/api/idempotency'

export const runtime = 'nodejs'

interface BreakInput { minimumQuantity?: unknown; unitPrice?: unknown }

async function itemExists(orgId: string, itemId: string) {
  return Boolean((await db.execute(sql`select 1 from items where org_id=${orgId} and id=${itemId}`)).rows[0])
}

function parseSchedule(body: Record<string, unknown>): { error: string } | {
  priceLevelId: string | null; customerId: string | null; currency: string; quantityBasis: string;
  effectiveFrom: string; effectiveTo: string | null; isActive: boolean;
  breaks: { minimumQuantity: string; unitPrice: string }[]
} {
  const priceLevelId = body.priceLevelId == null || body.priceLevelId === '' ? null : String(body.priceLevelId)
  const customerId = body.customerId == null || body.customerId === '' ? null : String(body.customerId)
  if (priceLevelId && !isUuid(priceLevelId)) return { error: 'Price level is invalid' }
  if (customerId && !isUuid(customerId)) return { error: 'Customer is invalid' }
  if (priceLevelId && customerId) return { error: 'Choose either a price level or a customer-specific price, not both' }
  if (!priceLevelId && !customerId) return { error: 'Choose a price level or a customer-specific price' }
  const currency = String(body.currency ?? '').trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) return { error: 'Currency must be a three-letter code' }
  const quantityBasis = String(body.quantityBasis ?? 'line_quantity')
  if (!['line_quantity', 'overall_item_quantity'].includes(quantityBasis)) return { error: 'Quantity basis is invalid' }
  const effectiveFrom = String(body.effectiveFrom ?? '')
  const effectiveToText = String(body.effectiveTo ?? '').trim()
  const effectiveTo = effectiveToText || null
  if (!isIsoCalendarDate(effectiveFrom) || (effectiveTo && !isIsoCalendarDate(effectiveTo))) return { error: 'Effective dates must be real calendar dates (YYYY-MM-DD)' }
  if (effectiveTo && effectiveTo < effectiveFrom) return { error: 'The end date cannot precede the start date' }
  if (!Array.isArray(body.breaks) || body.breaks.length === 0) return { error: 'Add at least one quantity break' }
  const breaks: { minimumQuantity: string; unitPrice: string }[] = []
  const seen = new Set<string>()
  for (const raw of body.breaks as BreakInput[]) {
    const quantity = canonicalDecimal(raw.minimumQuantity, 4)
    const price = canonicalDecimal(raw.unitPrice, 4)
    if (quantity === null || price === null || cmp(quantity, '0') <= 0 || cmp(price, '0') < 0) return { error: 'Break quantities must be positive and prices must be non-negative' }
    if (quantity.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length > 15 || price.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length > 15) return { error: 'Pricing values must fit within numeric(19,4)' }
    const normalizedQuantity = normalizeMoney(quantity)
    if (seen.has(normalizedQuantity)) return { error: 'Quantity breaks must be unique' }
    seen.add(normalizedQuantity)
    breaks.push({ minimumQuantity: normalizedQuantity, unitPrice: normalizeMoney(price) })
  }
  breaks.sort((a, b) => cmp(a.minimumQuantity, b.minimumQuantity))
  return { priceLevelId, customerId, currency, quantityBasis, effectiveFrom, effectiveTo, isActive: body.isActive !== false, breaks }
}

async function validateReferences(tx: Pick<typeof db, 'execute'>, orgId: string, parsed: Exclude<ReturnType<typeof parseSchedule>, { error: string }>) {
  if (!(await tx.execute(sql`select 1 from currencies where code=${parsed.currency}`)).rows[0]) throw new Error('Currency is not configured')
  if (parsed.priceLevelId && !(await tx.execute(sql`select 1 from price_levels where org_id=${orgId} and id=${parsed.priceLevelId} and is_active`)).rows[0]) throw new Error('Price level is not active in this organization')
  if (parsed.customerId && !(await tx.execute(sql`select 1 from customer_roles where org_id=${orgId} and party_id=${parsed.customerId} and is_active`)).rows[0]) throw new Error('Customer is not active in this organization')
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id) || !(await itemExists(gate.user.orgId, id))) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const [levels, customers, currencies, organization, schedules] = await Promise.all([
    db.execute(sql`select id,code,name,pricing_method,percentage,cost_basis,is_base from price_levels where org_id=${gate.user.orgId} and is_active order by is_base desc,name`),
    db.execute(sql`select p.id,p.display_name from parties p join customer_roles r on r.org_id=p.org_id and r.party_id=p.id and r.is_active where p.org_id=${gate.user.orgId} and p.is_active order by p.display_name limit 2000`),
    db.execute(sql`select code,name from currencies order by code`),
    db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id=${gate.user.orgId}`),
    db.execute(sql`
      select schedule.id,schedule.price_level_id,schedule.customer_id,schedule.currency,schedule.quantity_basis,
             schedule.effective_from::text,schedule.effective_to::text,schedule.is_active,
             level.name as price_level_name,customer.display_name as customer_name,
             coalesce(jsonb_agg(jsonb_build_object('id',price.id,'minimumQuantity',price.minimum_quantity::text,'unitPrice',price.unit_price::text) order by price.minimum_quantity) filter (where price.id is not null),'[]'::jsonb) as breaks
        from item_price_schedules schedule
        left join price_levels level on level.org_id=schedule.org_id and level.id=schedule.price_level_id
        left join parties customer on customer.org_id=schedule.org_id and customer.id=schedule.customer_id
        left join item_price_breaks price on price.org_id=schedule.org_id and price.schedule_id=schedule.id
       where schedule.org_id=${gate.user.orgId} and schedule.item_id=${id}
       group by schedule.id,level.name,customer.display_name
       order by schedule.effective_from desc,level.name nulls first,customer.display_name nulls first`),
  ])
  return NextResponse.json({
    levels: levels.rows,
    customers: customers.rows,
    currencies: currencies.rows,
    baseCurrency: organization.rows[0]?.base_currency ?? null,
    schedules: schedules.rows,
  })
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const requestId = request.headers.get('Idempotency-Key')?.trim() ?? ''
  if (!isUuid(requestId)) return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 400 })
  const parsedBody = await parseJsonBody(request, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const parsed = parseSchedule(parsedBody.data as Record<string, unknown>)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  try {
    const match = {
      item_id: id,
      price_level_id: parsed.priceLevelId,
      customer_id: parsed.customerId,
      currency: parsed.currency,
      quantity_basis: parsed.quantityBasis,
      effective_from: parsed.effectiveFrom,
      effective_to: parsed.effectiveTo,
      is_active: parsed.isActive,
      breaks: parsed.breaks,
    }
    const outcome = await db.transaction(async (tx) => {
      const claim = await claimIdempotentCreate(tx, { orgId: gate.user.orgId, table: 'item_price_schedules', key: requestId })
      if (claim === 'exists') {
        return { kind: 'replay' as const, result: await resolveIdempotentReplay(tx, { orgId: gate.user.orgId, table: 'item_price_schedules', key: requestId, match }) }
      }
      if (!(await tx.execute(sql`select 1 from items where org_id=${gate.user.orgId} and id=${id} for update`)).rows[0]) throw new Error('not found')
      await validateReferences(tx, gate.user.orgId, parsed)
      const row = (await tx.execute<Record<string, unknown>>(sql`
        insert into item_price_schedules (id,org_id,item_id,price_level_id,customer_id,currency,quantity_basis,effective_from,effective_to,is_active,created_by,updated_by)
        values (${requestId},${gate.user.orgId},${id},${parsed.priceLevelId},${parsed.customerId},${parsed.currency},${parsed.quantityBasis},${parsed.effectiveFrom},${parsed.effectiveTo},${parsed.isActive},${gate.user.id},${gate.user.id})
        on conflict (id) do nothing
        returning *`)).rows[0]
      if (!row) {
        return { kind: 'replay' as const, result: await resolveIdempotentReplay(tx, { orgId: gate.user.orgId, table: 'item_price_schedules', key: requestId, match }) }
      }
      for (const price of parsed.breaks) await tx.execute(sql`insert into item_price_breaks (org_id,schedule_id,minimum_quantity,unit_price,created_by,updated_by) values (${gate.user.orgId},${String(row.id)},${price.minimumQuantity},${price.unitPrice},${gate.user.id},${gate.user.id})`)
      await auditSetupChange({ orgId: gate.user.orgId, table: 'item_price_schedules', rowId: String(row.id), action: 'insert', changes: { before: null, after: { ...match, id: requestId, org_id: gate.user.orgId } }, actorId: gate.user.id, requestId }, tx)
      return { kind: 'created' as const }
    })
    if (outcome.kind === 'replay' && outcome.result === 'conflict') return NextResponse.json({ error: 'invalid_idempotency_key' }, { status: 409 })
    return NextResponse.json({ id: requestId }, { status: outcome.kind === 'created' ? 201 : 200 })
  } catch (error) {
    const code = (error as { code?: string }).code
    return NextResponse.json({ error: code === '23P01' ? 'An active pricing schedule already covers that scope and date range' : error instanceof Error ? error.message : 'Pricing schedule could not be saved' }, { status: code === '23P01' ? 409 : 400 })
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const parsedBody = await parseJsonBody(request, jsonObject)
  if (!parsedBody.ok) return parsedBody.response
  const body = parsedBody.data as Record<string, unknown>
  const scheduleId = String(body.id ?? '')
  if (!isUuid(scheduleId)) return NextResponse.json({ error: 'Schedule id is required' }, { status: 400 })
  const parsed = parseSchedule(body)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  try {
    const found = await db.transaction(async (tx) => {
      const before = (await tx.execute<Record<string, unknown>>(sql`select * from item_price_schedules where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} for update`)).rows[0]
      if (!before) return false
      await validateReferences(tx, gate.user.orgId, parsed)
      const priorBreaks = (await tx.execute(sql`select minimum_quantity::text,unit_price::text from item_price_breaks where org_id=${gate.user.orgId} and schedule_id=${scheduleId} order by minimum_quantity`)).rows
      const after = (await tx.execute<Record<string, unknown>>(sql`update item_price_schedules set price_level_id=${parsed.priceLevelId},customer_id=${parsed.customerId},currency=${parsed.currency},quantity_basis=${parsed.quantityBasis},effective_from=${parsed.effectiveFrom},effective_to=${parsed.effectiveTo},is_active=${parsed.isActive},updated_at=now(),updated_by=${gate.user.id} where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} returning *`)).rows[0]!
      await tx.execute(sql`delete from item_price_breaks where org_id=${gate.user.orgId} and schedule_id=${scheduleId}`)
      for (const price of parsed.breaks) await tx.execute(sql`insert into item_price_breaks (org_id,schedule_id,minimum_quantity,unit_price,created_by,updated_by) values (${gate.user.orgId},${scheduleId},${price.minimumQuantity},${price.unitPrice},${gate.user.id},${gate.user.id})`)
      await auditSetupChange({ orgId: gate.user.orgId, table: 'item_price_schedules', rowId: scheduleId, action: 'update', changes: { before: { ...before, breaks: priorBreaks }, after: { ...after, breaks: parsed.breaks } }, actorId: gate.user.id }, tx)
      return true
    })
    return found ? NextResponse.json({ id: scheduleId }) : NextResponse.json({ error: 'not found' }, { status: 404 })
  } catch (error) {
    const code = (error as { code?: string }).code
    return NextResponse.json({ error: code === '23P01' ? 'An active pricing schedule already covers that scope and date range' : error instanceof Error ? error.message : 'Pricing schedule could not be saved' }, { status: code === '23P01' ? 409 : 400 })
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const scheduleId = new URL(request.url).searchParams.get('schedule') ?? ''
  if (!isUuid(id) || !isUuid(scheduleId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const found = await db.transaction(async (tx) => {
    const before = (await tx.execute<Record<string, unknown>>(sql`select * from item_price_schedules where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} for update`)).rows[0]
    if (!before) return false
    const breaks = (await tx.execute(sql`select minimum_quantity::text,unit_price::text from item_price_breaks where org_id=${gate.user.orgId} and schedule_id=${scheduleId} order by minimum_quantity`)).rows
    const deleted = await tx.execute(sql`delete from item_price_schedules where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} returning id`)
    if (!deleted.rows[0]) throw new Error('Pricing schedule was not deleted')
    await auditSetupChange({ orgId: gate.user.orgId, table: 'item_price_schedules', rowId: scheduleId, action: 'delete', changes: { before: { ...before, breaks } }, actorId: gate.user.id }, tx)
    return true
  })
  return found ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'not found' }, { status: 404 })
}
