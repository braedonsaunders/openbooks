import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.item-price-history-test')
const routeState: { authz: { user: { orgId: string; id: string } } | null } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === '@/lib/authz') return { shortCircuit: true, url: 'mock:item-price-history-authz' }
    if (specifier.startsWith('@/') && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:item-price-history-authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
          export async function guardPermission() {
            const state = globalThis[Symbol.for('openbooks.item-price-history-test')]
            return state.authz ?? new Response(null, { status: 403 })
          }
        `,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?item-price-history'
const { POST, PATCH, DELETE } = (await import(routeUrl)) as typeof import('./route.ts')
const { resolveItemPrice } = await import('../../../../../lib/item-pricing.ts')
hooks.deregister()

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const DB = Boolean(process.env.OPENBOOKS_DB_URL)

interface Fixture { orgId: string; actorId: string; itemId: string; priceLevelId: string }

async function fixture(): Promise<Fixture> {
  const org = await createScratchOrg()
  const actorId = (await seedFlowActors(org.orgId)).adminId
  const baseLevel = (await db.execute<{ id: string }>(sql`select id from price_levels where org_id=${org.orgId} and is_base and is_active`)).rows[0]
  assert.ok(baseLevel, 'migration must seed one active base price level')
  return { orgId: org.orgId, actorId, itemId: org.items.service, priceLevelId: baseLevel.id }
}

async function today(): Promise<string> {
  return String((await db.execute<{ today: string }>(sql`select current_date::text as today`)).rows[0]!.today)
}

function shift(day: string, delta: number): string {
  const base = new Date(`${day}T00:00:00Z`)
  base.setUTCDate(base.getUTCDate() + delta)
  return base.toISOString().slice(0, 10)
}

function scheduleBody(f: Fixture, effectiveFrom: string, unitPrice: string, extra: Record<string, unknown> = {}) {
  return {
    priceLevelId: f.priceLevelId,
    currency: 'CAD',
    quantityBasis: 'line_quantity',
    effectiveFrom,
    effectiveTo: null,
    isActive: true,
    breaks: [{ minimumQuantity: '1', unitPrice }],
    ...extra,
  }
}

async function postSchedule(f: Fixture, effectiveFrom: string, unitPrice: string) {
  routeState.authz = { user: { orgId: f.orgId, id: f.actorId } }
  const response = await POST(new Request(`http://openbooks.test/api/items/${f.itemId}/prices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify(scheduleBody(f, effectiveFrom, unitPrice)),
  }), { params: Promise.resolve({ id: f.itemId }) })
  assert.equal(response.status, 201)
  return String((await response.json()).id)
}

async function patchSchedule(f: Fixture, body: Record<string, unknown>) {
  routeState.authz = { user: { orgId: f.orgId, id: f.actorId } }
  return PATCH(new Request(`http://openbooks.test/api/items/${f.itemId}/prices`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: f.itemId }) })
}

async function deleteSchedule(f: Fixture, scheduleId: string, revision?: number, reason?: string) {
  routeState.authz = { user: { orgId: f.orgId, id: f.actorId } }
  const params = new URLSearchParams({ schedule: scheduleId })
  if (revision !== undefined) params.set('revision', String(revision))
  if (reason !== undefined) params.set('reason', reason)
  return DELETE(new Request(`http://openbooks.test/api/items/${f.itemId}/prices?${params}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: f.itemId }) })
}

async function priceOn(f: Fixture, onDate: string) {
  return resolveItemPrice({ orgId: f.orgId, itemId: f.itemId, customerId: null, currency: 'CAD', lineQuantity: '1', onDate })
}

async function scheduleRows(f: Fixture) {
  return (await db.execute<{ id: string; is_active: boolean; effective_from: string; effective_to: string | null; supersedes_id: string | null; change_reason: string | null }>(sql`
    select id, is_active, effective_from::text as effective_from, effective_to::text as effective_to, supersedes_id, change_reason
      from item_price_schedules where org_id=${f.orgId} and item_id=${f.itemId} order by effective_from, supersedes_id nulls first, id`)).rows
}

async function breakPrices(f: Fixture, scheduleId: string) {
  return (await db.execute<{ unit_price: string }>(sql`select unit_price::text from item_price_breaks where org_id=${f.orgId} and schedule_id=${scheduleId}`)).rows.map((row) => row.unit_price)
}

test('a retroactive price change without a reason is refused and changes nothing', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const now = await today()
    const scheduleId = await postSchedule(f, shift(now, -60), '100.0000')
    const response = await patchSchedule(f, { id: scheduleId, revision: 0, ...scheduleBody(f, shift(now, -60), '70.0000') })
    assert.equal(response.status, 400)
    assert.match(String((await response.json()).error), /reason/i)
    assert.deepEqual(await scheduleRows(f), [{
      id: scheduleId, is_active: true, effective_from: shift(now, -60), effective_to: null, supersedes_id: null, change_reason: null,
    }])
    assert.deepEqual(await breakPrices(f, scheduleId), ['100.0000'])
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('a reasoned correction creates a version while the prior version is retained', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const now = await today()
    const effectiveFrom = shift(now, -60)
    const scheduleId = await postSchedule(f, effectiveFrom, '100.0000')
    const response = await patchSchedule(f, { id: scheduleId, revision: 0, ...scheduleBody(f, effectiveFrom, '70.0000'), reason: 'Supplier list price was entered net of discount' })
    assert.equal(response.status, 200)
    const versionId = String((await response.json()).id)
    assert.notEqual(versionId, scheduleId)
    // The prior version is retired but retained with its old breaks.
    assert.deepEqual(await scheduleRows(f), [
      { id: scheduleId, is_active: false, effective_from: effectiveFrom, effective_to: null, supersedes_id: null, change_reason: null },
      { id: versionId, is_active: true, effective_from: effectiveFrom, effective_to: null, supersedes_id: scheduleId, change_reason: 'Supplier list price was entered net of discount' },
    ])
    assert.deepEqual(await breakPrices(f, scheduleId), ['100.0000'])
    assert.deepEqual(await breakPrices(f, versionId), ['70.0000'])
    const audits = (await db.execute<{ changes: string }>(sql`select changes::text from audit_log where org_id=${f.orgId} and table_name='item_price_schedules' and row_id=${scheduleId} and action='update' order by id desc limit 1`)).rows
    assert.match(audits[0]!.changes, /Supplier list price was entered net of discount/)
    // A correction applies to the period it corrects: a late transaction in
    // the corrected period reprices under the new version. (A prospective
    // successor, below, is what leaves history untouched.)
    const corrected = await priceOn(f, shift(now, -30))
    assert.equal(corrected?.unitPrice, '70.0000')
    assert.equal(corrected?.scheduleId, versionId)
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('a prospective successor leaves a late transaction in the old window under the old price', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const now = await today()
    const scheduleId = await postSchedule(f, shift(now, -60), '100.0000')
    const successorFrom = shift(now, 30)
    const response = await patchSchedule(f, { id: scheduleId, revision: 0, ...scheduleBody(f, successorFrom, '70.0000') })
    assert.equal(response.status, 200)
    const versionId = String((await response.json()).id)
    assert.notEqual(versionId, scheduleId)
    assert.deepEqual(await scheduleRows(f), [
      { id: scheduleId, is_active: true, effective_from: shift(now, -60), effective_to: shift(successorFrom, -1), supersedes_id: null, change_reason: null },
      { id: versionId, is_active: true, effective_from: successorFrom, effective_to: null, supersedes_id: scheduleId, change_reason: null },
    ])
    const history = await priceOn(f, shift(now, -30))
    assert.equal(history?.unitPrice, '100.0000')
    assert.equal(history?.scheduleId, scheduleId)
    const future = await priceOn(f, successorFrom)
    assert.equal(future?.unitPrice, '70.0000')
    assert.equal(future?.scheduleId, versionId)
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('DELETE of an effective schedule needs a reason and then end-dates instead of deleting', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const now = await today()
    const scheduleId = await postSchedule(f, shift(now, -60), '100.0000')
    const unversioned = await deleteSchedule(f, scheduleId)
    assert.equal(unversioned.status, 400)
    assert.match(String((await unversioned.json()).error), /revision/i)
    const refused = await deleteSchedule(f, scheduleId, 0)
    assert.equal(refused.status, 400)
    assert.match(String((await refused.json()).error), /reason/i)
    assert.equal((await scheduleRows(f)).length, 1)
    const ended = await deleteSchedule(f, scheduleId, 0, 'Promotion ended')
    assert.equal(ended.status, 200)
    assert.deepEqual(await ended.json(), { ok: true, endDated: true })
    assert.deepEqual(await scheduleRows(f), [{
      id: scheduleId, is_active: true, effective_from: shift(now, -60), effective_to: now, supersedes_id: null, change_reason: 'Promotion ended',
    }])
    const history = await priceOn(f, shift(now, -30))
    assert.equal(history?.unitPrice, '100.0000')
    assert.equal(history?.scheduleId, scheduleId)
    const future = await priceOn(f, shift(now, 30))
    assert.notEqual(future?.scheduleId, scheduleId)
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('DELETE of a never-effective schedule removes it, and of an ended schedule is refused', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const now = await today()
    const futureId = await postSchedule(f, shift(now, 30), '100.0000')
    const deleted = await deleteSchedule(f, futureId, 0)
    assert.equal(deleted.status, 200)
    assert.deepEqual(await deleted.json(), { ok: true, endDated: false })
    assert.deepEqual(await scheduleRows(f), [])
    const audits = (await db.execute<{ action: string }>(sql`select action from audit_log where org_id=${f.orgId} and table_name='item_price_schedules' and row_id=${futureId} order by id desc limit 1`)).rows
    assert.equal(audits[0]?.action, 'delete')

    routeState.authz = { user: { orgId: f.orgId, id: f.actorId } }
    const endedResponse = await POST(new Request(`http://openbooks.test/api/items/${f.itemId}/prices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ ...scheduleBody(f, shift(now, -60), '50.0000'), effectiveTo: shift(now, -30) }),
    }), { params: Promise.resolve({ id: f.itemId }) })
    assert.equal(endedResponse.status, 201)
    const endedId = String((await endedResponse.json()).id)
    const refused = await deleteSchedule(f, endedId, 0, 'cleanup')
    assert.equal(refused.status, 422)
    assert.match(String((await refused.json()).error), /retained as pricing history/)
    assert.equal((await scheduleRows(f)).length, 1)
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('POST over a retained prior version is refused instead of forking history', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const now = await today()
    const effectiveFrom = shift(now, 30)
    const scheduleId = await postSchedule(f, effectiveFrom, '100.0000')
    // Deactivating a never-effective schedule is future-only, so no reason
    // is needed — but the row is retained, and a create over its window
    // must edit it instead of forking a second row.
    const deactivated = await patchSchedule(f, { id: scheduleId, revision: 0, ...scheduleBody(f, effectiveFrom, '100.0000'), isActive: false })
    assert.equal(deactivated.status, 200)
    routeState.authz = { user: { orgId: f.orgId, id: f.actorId } }
    const forked = await POST(new Request(`http://openbooks.test/api/items/${f.itemId}/prices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(scheduleBody(f, effectiveFrom, '55.0000')),
    }), { params: Promise.resolve({ id: f.itemId }) })
    assert.equal(forked.status, 409)
    assert.match(String((await forked.json()).error), /retained prior version/)
    assert.equal((await scheduleRows(f)).length, 1)
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})
