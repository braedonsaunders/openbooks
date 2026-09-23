import { randomUUID } from 'node:crypto'
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

/** Normalize a DATE column value (driver may return a Date or a string) to YYYY-MM-DD. */
function toDay(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

/** Add (or subtract) whole days to a YYYY-MM-DD calendar date in UTC. */
function addDays(day: string, delta: number): string {
  const base = new Date(`${day}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + delta)
  return base.toISOString().slice(0, 10)
}

function breaksEqual(prior: { minimum_quantity: string; unit_price: string }[], next: { minimumQuantity: string; unitPrice: string }[]): boolean {
  if (prior.length !== next.length) return false
  return prior.every((row, index) => {
    const candidate = next[index]!
    return (canonicalDecimal(row.minimum_quantity, 4) ?? row.minimum_quantity) === (canonicalDecimal(candidate.minimumQuantity, 4) ?? candidate.minimumQuantity)
      && (canonicalDecimal(row.unit_price, 4) ?? row.unit_price) === (canonicalDecimal(candidate.unitPrice, 4) ?? candidate.unitPrice)
  })
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
             schedule.revision,schedule.supersedes_id,schedule.change_reason,
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
      // A retained prior version (inactive) still owns its window: creating
      // over it would silently fork history, so a correction must go through
      // PATCH with a reason instead. The overlap exclusion below stays as the
      // backstop for a concurrent insert that slips past this read.
      const scopeOverlap = parsed.customerId
        ? sql`schedule.customer_id = ${parsed.customerId}`
        : sql`schedule.customer_id is null and schedule.price_level_id = ${parsed.priceLevelId}`
      const overlapped = (await tx.execute(sql`
        select schedule.id, schedule.is_active from item_price_schedules schedule
         where schedule.org_id = ${gate.user.orgId} and schedule.item_id = ${id}
           and schedule.currency = ${parsed.currency} and (${scopeOverlap})
           and schedule.effective_from <= coalesce(${parsed.effectiveTo}::date, 'infinity'::date)
           and ${parsed.effectiveFrom}::date <= coalesce(schedule.effective_to, 'infinity'::date)
         limit 1`)).rows[0] as { id: string; is_active: boolean } | undefined
      if (overlapped) {
        throw new Error(overlapped.is_active
          ? 'An active pricing schedule already covers that scope and date range'
          : 'A retained prior version already covers that scope and date range; edit the existing schedule instead')
      }
      const row = (await tx.execute<Record<string, unknown>>(sql`
        insert into item_price_schedules (id,org_id,item_id,price_level_id,customer_id,currency,quantity_basis,effective_from,effective_to,is_active,created_by,updated_by)
        values (${requestId},${gate.user.orgId},${id},${parsed.priceLevelId},${parsed.customerId},${parsed.currency},${parsed.quantityBasis},${parsed.effectiveFrom},${parsed.effectiveTo},${parsed.isActive},${gate.user.id},${gate.user.id})
        -- The row id IS the idempotency key: a retried insert with the same
        -- key collides here and resolves through resolveIdempotentReplay.
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
    const message = error instanceof Error ? error.message : 'Pricing schedule could not be saved'
    if (code === '23P01' || message === 'An active pricing schedule already covers that scope and date range') {
      return NextResponse.json({ error: 'An active pricing schedule already covers that scope and date range' }, { status: 409 })
    }
    if (message === 'A retained prior version already covers that scope and date range; edit the existing schedule instead') {
      return NextResponse.json({ error: message }, { status: 409 })
    }
    return NextResponse.json({ error: message }, { status: code === '23P01' ? 409 : 400 })
  }
}

interface LockedSchedule extends Record<string, unknown> {
  id: string
  price_level_id: string | null
  customer_id: string | null
  currency: string
  quantity_basis: string
  is_active: boolean
  revision: number
  supersedes_id: string | null
  change_reason: string | null
  from_day: string
  to_day: string | null
}

/**
 * Price schedules are effective-dated and version-preserving: the resolver
 * reads the version effective on the transaction date, so a change must
 * never rewrite an already-effective period in place. PATCH therefore has
 * three flows. A prospective change (the schedule was already effective and
 * the new window starts in the future) truncates the predecessor and
 * inserts a successor: past resolution is untouched, so no reason is
 * needed. A history-touching change (new prices covering an
 * already-effective date) inserts a corrected version over the same window
 * and retires the prior row, and requires an explicit reason recorded in
 * the audit and on the new row. Anything else (a never-effective schedule,
 * future end-dating, reactivation that stays in the future) edits the row
 * in place. Inactive rows are retained history and cannot be edited except
 * by reactivating them.
 */
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
  const reason = String(body.reason ?? '').trim()
  try {
    const outcome = await db.transaction(async (tx) => {
      const today = String((await tx.execute<{ today: string }>(sql`select current_date::text as today`)).rows[0]!.today)
      const locked = (await tx.execute(sql`
        select *,effective_from::text as from_day,effective_to::text as to_day
          from item_price_schedules
         where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} for update`))
        .rows[0] as LockedSchedule | undefined
      if (!locked) return { kind: 'missing' as const }
      const before = {
        priceLevelId: locked.price_level_id,
        customerId: locked.customer_id,
        currency: locked.currency,
        quantityBasis: locked.quantity_basis,
        fromDay: toDay(locked.from_day),
        toDay: locked.to_day === null ? null : toDay(locked.to_day),
        isActive: locked.is_active,
      }
      await validateReferences(tx, gate.user.orgId, parsed)
      const priorBreaks = (await tx.execute<{ minimum_quantity: string; unit_price: string }>(sql`select minimum_quantity::text,unit_price::text from item_price_breaks where org_id=${gate.user.orgId} and schedule_id=${scheduleId} order by minimum_quantity`)).rows
      const contentChanged = before.priceLevelId !== parsed.priceLevelId
        || before.customerId !== parsed.customerId
        || before.currency !== parsed.currency
        || before.quantityBasis !== parsed.quantityBasis
        || !breaksEqual(priorBreaks, parsed.breaks)
      const windowChanged = before.fromDay !== parsed.effectiveFrom || before.toDay !== parsed.effectiveTo
      const coversPastBefore = before.isActive && before.fromDay <= today
      const coversPastAfter = parsed.isActive && parsed.effectiveFrom <= today
      // An end-date change only touches history when the past-coverage
      // endpoint moves: narrowing or widening inside the future keeps every
      // already-effective date resolving exactly as before.
      const pastEndpoint = (endpoint: string | null) => (endpoint === null || endpoint > today ? 'FUTURE' : endpoint)
      const endTouchesHistory = pastEndpoint(before.toDay) !== pastEndpoint(parsed.effectiveTo)

      if (!before.isActive && !parsed.isActive) {
        return { kind: 'refused' as const, status: 422, error: 'This schedule is a retained prior version; history cannot be edited — reload and edit the current version instead' }
      }
      if (before.isActive && !parsed.isActive && coversPastBefore) {
        return { kind: 'refused' as const, status: 422, error: 'Deactivating would hide prices that are already effective; end-date the schedule instead' }
      }
      // Prospective successor: the predecessor keeps its prices through the
      // day before the new window, so a late transaction inside the old
      // window still prices under the old version.
      const successor = before.isActive && parsed.isActive && before.fromDay <= today && parsed.effectiveFrom > today
      const touchesHistory = successor ? false : (
        (contentChanged && coversPastAfter)
        || (parsed.effectiveFrom !== before.fromDay && (coversPastBefore || coversPastAfter))
        || (windowChanged && endTouchesHistory)
        || (!before.isActive && parsed.isActive && coversPastAfter)
      )
      if (touchesHistory && !reason) {
        return { kind: 'refused' as const, status: 400, error: 'This schedule already prices effective dates. Provide a reason for the correction; the prior version is kept and the reason is recorded in the audit' }
      }

      const insertVersion = async (supersedesId: string, changeReason: string | null) => {
        const versionId = randomUUID()
        await tx.execute(sql`
          insert into item_price_schedules (id,org_id,item_id,price_level_id,customer_id,currency,quantity_basis,effective_from,effective_to,is_active,revision,supersedes_id,change_reason,created_by,updated_by)
          values (${versionId},${gate.user.orgId},${id},${parsed.priceLevelId},${parsed.customerId},${parsed.currency},${parsed.quantityBasis},${parsed.effectiveFrom},${parsed.effectiveTo},${parsed.isActive},0,${supersedesId},${changeReason},${gate.user.id},${gate.user.id})`)
        for (const price of parsed.breaks) await tx.execute(sql`insert into item_price_breaks (org_id,schedule_id,minimum_quantity,unit_price,created_by,updated_by) values (${gate.user.orgId},${versionId},${price.minimumQuantity},${price.unitPrice},${gate.user.id},${gate.user.id})`)
        await auditSetupChange({ orgId: gate.user.orgId, table: 'item_price_schedules', rowId: versionId, action: 'insert', changes: { before: null, after: { item_id: id, price_level_id: parsed.priceLevelId, customer_id: parsed.customerId, currency: parsed.currency, quantity_basis: parsed.quantityBasis, effective_from: parsed.effectiveFrom, effective_to: parsed.effectiveTo, is_active: parsed.isActive, supersedes_id: supersedesId, change_reason: changeReason, breaks: parsed.breaks } }, actorId: gate.user.id }, tx)
        return versionId
      }

      if (successor) {
        // Truncate only when the predecessor still covers the successor
        // start; an already-ended predecessor is left untouched.
        const truncates = before.toDay === null || before.toDay >= parsed.effectiveFrom
        const truncatedTo = addDays(parsed.effectiveFrom, -1)
        if (truncates && truncatedTo < before.fromDay) throw new Error('The successor must start after the current schedule begins')
        const after = truncates
          ? (await tx.execute<LockedSchedule>(sql`update item_price_schedules set effective_to=${truncatedTo},updated_at=now(),updated_by=${gate.user.id},revision=revision+1 where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} returning *`)).rows[0]!
          : locked
        if (truncates) {
          await auditSetupChange({ orgId: gate.user.orgId, table: 'item_price_schedules', rowId: scheduleId, action: 'update', changes: { before: { ...locked, breaks: priorBreaks }, after: { ...after, breaks: priorBreaks } }, actorId: gate.user.id }, tx)
        }
        const versionId = await insertVersion(scheduleId, null)
        return { kind: 'saved' as const, scheduleId: versionId }
      }

      if (touchesHistory) {
        // Reasoned correction: the new version carries the requested window
        // (past dates reprice under it — that is what a correction is for)
        // and the prior row is retired but retained. The predecessor is
        // retired BEFORE the insert so the two active windows never coexist
        // under the overlap exclusion.
        const retired = (await tx.execute<LockedSchedule>(sql`update item_price_schedules set is_active=false,updated_at=now(),updated_by=${gate.user.id},revision=revision+1 where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} returning *`)).rows[0]!
        await auditSetupChange({ orgId: gate.user.orgId, table: 'item_price_schedules', rowId: scheduleId, action: 'update', changes: { before: { ...locked, breaks: priorBreaks }, after: { ...retired, breaks: priorBreaks }, reason }, actorId: gate.user.id }, tx)
        const versionId = await insertVersion(scheduleId, reason)
        return { kind: 'saved' as const, scheduleId: versionId }
      }

      const after = (await tx.execute<LockedSchedule>(sql`update item_price_schedules set price_level_id=${parsed.priceLevelId},customer_id=${parsed.customerId},currency=${parsed.currency},quantity_basis=${parsed.quantityBasis},effective_from=${parsed.effectiveFrom},effective_to=${parsed.effectiveTo},is_active=${parsed.isActive},updated_at=now(),updated_by=${gate.user.id},revision=revision+1 where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} returning *`)).rows[0]!
      await tx.execute(sql`delete from item_price_breaks where org_id=${gate.user.orgId} and schedule_id=${scheduleId}`)
      for (const price of parsed.breaks) await tx.execute(sql`insert into item_price_breaks (org_id,schedule_id,minimum_quantity,unit_price,created_by,updated_by) values (${gate.user.orgId},${scheduleId},${price.minimumQuantity},${price.unitPrice},${gate.user.id},${gate.user.id})`)
      await auditSetupChange({ orgId: gate.user.orgId, table: 'item_price_schedules', rowId: scheduleId, action: 'update', changes: { before: { ...locked, breaks: priorBreaks }, after: { ...after, breaks: parsed.breaks }, ...(reason ? { reason } : {}) }, actorId: gate.user.id }, tx)
      return { kind: 'saved' as const, scheduleId }
    })
    if (outcome.kind === 'missing') return NextResponse.json({ error: 'not found' }, { status: 404 })
    if (outcome.kind === 'refused') return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json({ id: outcome.scheduleId })
  } catch (error) {
    const code = (error as { code?: string }).code
    return NextResponse.json({ error: code === '23P01' ? 'An active pricing schedule already covers that scope and date range' : error instanceof Error ? error.message : 'Pricing schedule could not be saved' }, { status: code === '23P01' ? 409 : 400 })
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('items.manage')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  const query = new URL(request.url).searchParams
  const scheduleId = query.get('schedule') ?? ''
  if (!isUuid(id) || !isUuid(scheduleId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const reason = (query.get('reason') ?? '').trim()
  const outcome = await db.transaction(async (tx) => {
    const today = String((await tx.execute<{ today: string }>(sql`select current_date::text as today`)).rows[0]!.today)
    const locked = (await tx.execute(sql`
      select *,effective_from::text as from_day,effective_to::text as to_day
        from item_price_schedules
       where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} for update`))
      .rows[0] as LockedSchedule | undefined
    if (!locked) return { kind: 'missing' as const }
    const breaks = (await tx.execute(sql`select minimum_quantity::text,unit_price::text from item_price_breaks where org_id=${gate.user.orgId} and schedule_id=${scheduleId} order by minimum_quantity`)).rows
    const fromDay = toDay(locked.from_day)
    const toDayValue = locked.to_day === null ? null : toDay(locked.to_day)
    // Only a never-effective schedule may be deleted: anything that priced
    // (or could have priced) a real transaction stays as history.
    if (fromDay <= today) {
      if (!locked.is_active) {
        return { kind: 'refused' as const, status: 422, error: 'This schedule is a retained prior version; history cannot be deleted' }
      }
      if (toDayValue !== null && toDayValue < today) {
        return { kind: 'refused' as const, status: 422, error: `This schedule ended on ${toDayValue} and is retained as pricing history; it cannot be deleted` }
      }
      if (!reason) {
        return { kind: 'refused' as const, status: 400, error: 'This schedule is already effective. Provide a reason to end it; the schedule stays in history with an effective-to date' }
      }
      const endedTo = toDayValue === null || toDayValue > today ? today : toDayValue
      const after = (await tx.execute<LockedSchedule>(sql`update item_price_schedules set effective_to=${endedTo},change_reason=${reason},updated_at=now(),updated_by=${gate.user.id},revision=revision+1 where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} returning *`)).rows[0]!
      await auditSetupChange({ orgId: gate.user.orgId, table: 'item_price_schedules', rowId: scheduleId, action: 'update', changes: { before: { ...locked, breaks }, after: { ...after, breaks }, reason, requestedAction: 'delete (end-dated)' }, actorId: gate.user.id }, tx)
      return { kind: 'ended' as const }
    }
    // A future schedule never priced anything: hard-delete it with its breaks.
    const deleted = await tx.execute(sql`delete from item_price_schedules where org_id=${gate.user.orgId} and item_id=${id} and id=${scheduleId} returning id`)
    if (!deleted.rows[0]) throw new Error('Pricing schedule was not deleted')
    await auditSetupChange({ orgId: gate.user.orgId, table: 'item_price_schedules', rowId: scheduleId, action: 'delete', changes: { before: { ...locked, breaks } }, actorId: gate.user.id }, tx)
    return { kind: 'deleted' as const }
  })
  if (outcome.kind === 'missing') return NextResponse.json({ error: 'not found' }, { status: 404 })
  if (outcome.kind === 'refused') return NextResponse.json({ error: outcome.error }, { status: outcome.status })
  return NextResponse.json({ ok: true, endDated: outcome.kind === 'ended' })
}
