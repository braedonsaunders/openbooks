import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.item-price-revision-test')
const routeState: { authz: { user: { orgId: string; id: string } } | null } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === '@/lib/authz') return { shortCircuit: true, url: 'mock:item-price-revision-authz' }
    if (specifier.startsWith('@/') && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:item-price-revision-authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
          export async function guardPermission() {
            const state = globalThis[Symbol.for('openbooks.item-price-revision-test')]
            return state.authz ?? new Response(null, { status: 403 })
          }
        `,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?item-price-revision'
const { POST, PATCH, DELETE, GET } = (await import(routeUrl)) as typeof import('./route.ts')
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

async function deleteSchedule(f: Fixture, query: string) {
  routeState.authz = { user: { orgId: f.orgId, id: f.actorId } }
  return DELETE(new Request(`http://openbooks.test/api/items/${f.itemId}/prices?${query}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id: f.itemId }) })
}

async function getSchedules(f: Fixture) {
  routeState.authz = { user: { orgId: f.orgId, id: f.actorId } }
  const response = await GET(new Request(`http://openbooks.test/api/items/${f.itemId}/prices`),
    { params: Promise.resolve({ id: f.itemId }) })
  assert.equal(response.status, 200)
  return (await response.json()).schedules as { id: string; revision: number }[]
}

test('PATCH without a revision never reaches the row', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const now = await today()
    const scheduleId = await postSchedule(f, shift(now, 30), '100.0000')
    for (const revision of [undefined, 'zero', -1, 1.5]) {
      const body: Record<string, unknown> = { id: scheduleId, ...scheduleBody(f, shift(now, 30), '70.0000') }
      if (revision !== undefined) body.revision = revision
      const response = await patchSchedule(f, body)
      assert.equal(response.status, 400)
      assert.match(String((await response.json()).error), /revision.*reload/i)
    }
    const rows = await getSchedules(f)
    assert.deepEqual(rows.map((row) => [row.id, row.revision]), [[scheduleId, 0]])
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('two editors racing on one schedule: the second gets a 409 with a reload remedy', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const now = await today()
    const scheduleId = await postSchedule(f, shift(now, 30), '100.0000')
    // Both editors read revision 0. The first commits (in-place: the
    // schedule is still future), bumping the row to revision 1.
    const first = await patchSchedule(f, { id: scheduleId, revision: 0, ...scheduleBody(f, shift(now, 30), '70.0000') })
    assert.equal(first.status, 200)
    // The second editor's whole schedule-and-break write is refused instead
    // of silently overwriting the first editor's prices.
    const second = await patchSchedule(f, { id: scheduleId, revision: 0, ...scheduleBody(f, shift(now, 30), '55.0000') })
    assert.equal(second.status, 409)
    assert.match(String((await second.json()).error), /reload and try again/i)
    const breaks = (await db.execute<{ unit_price: string }>(sql`select unit_price::text from item_price_breaks where org_id=${f.orgId} and schedule_id=${scheduleId}`)).rows
    assert.deepEqual(breaks.map((row) => row.unit_price), ['70.0000'])
    const rows = await getSchedules(f)
    assert.deepEqual(rows.map((row) => [row.id, row.revision]), [[scheduleId, 1]])
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('a stale revision on a superseded schedule is refused, and DELETE is fenced too', { skip: !DB }, async () => {
  const f = await fixture()
  try {
    const now = await today()
    const effectiveFrom = shift(now, -60)
    const scheduleId = await postSchedule(f, effectiveFrom, '100.0000')
    const corrected = await patchSchedule(f, { id: scheduleId, revision: 0, ...scheduleBody(f, effectiveFrom, '70.0000'), reason: 'correction' })
    assert.equal(corrected.status, 200)
    // The retired row was bumped, so the revision its editor holds is stale.
    const stale = await patchSchedule(f, { id: scheduleId, revision: 0, ...scheduleBody(f, effectiveFrom, '60.0000'), reason: 'late correction' })
    assert.equal(stale.status, 409)
    assert.match(String((await stale.json()).error), /reload and try again/i)
    // DELETE without a token never reaches the row; a stale token is refused.
    const unversioned = await deleteSchedule(f, `schedule=${scheduleId}`)
    assert.equal(unversioned.status, 400)
    assert.match(String((await unversioned.json()).error), /revision.*reload/i)
    const staleDelete = await deleteSchedule(f, `schedule=${scheduleId}&revision=0&reason=nope`)
    assert.equal(staleDelete.status, 409)
    assert.match(String((await staleDelete.json()).error), /reload and try again/i)
    // The retired row is still retained history, untouched by both attempts.
    const retained = (await db.execute<{ is_active: boolean; revision: number }>(sql`select is_active, revision from item_price_schedules where org_id=${f.orgId} and id=${scheduleId}`)).rows[0]
    assert.deepEqual(retained, { is_active: false, revision: 1 })
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})
