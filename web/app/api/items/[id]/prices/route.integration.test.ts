import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.item-prices-route-test')
const routeState: { authz: { user: { orgId: string; id: string } } | null } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === '@/lib/authz') return { shortCircuit: true, url: 'mock:item-price-authz' }
    if (specifier.startsWith('@/') && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:item-price-authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
          export async function guardPermission() {
            const state = globalThis[Symbol.for('openbooks.item-prices-route-test')]
            return state.authz ?? new Response(null, { status: 403 })
          }
        `,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?item-price-route-integration'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

const { db } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const DB = Boolean(process.env.OPENBOOKS_DB_URL)

async function fixture() {
  const org = await createScratchOrg()
  const actorId = (await seedFlowActors(org.orgId)).adminId
  const baseLevel = (await db.execute<{ id: string }>(sql`select id from price_levels where org_id=${org.orgId} and is_base and is_active`)).rows[0]
  assert.ok(baseLevel, 'migration must seed one active base price level')
  return { orgId: org.orgId, actorId, itemId: org.items.service, priceLevelId: baseLevel.id }
}

function post(input: { orgId: string; actorId: string; itemId: string; priceLevelId: string }, key: string, unitPrice = '12.3400') {
  routeState.authz = { user: { orgId: input.orgId, id: input.actorId } }
  return POST(new Request(`http://openbooks.test/api/items/${input.itemId}/prices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({
      priceLevelId: input.priceLevelId,
      currency: 'CAD',
      quantityBasis: 'line_quantity',
      effectiveFrom: '2026-09-22',
      breaks: [{ minimumQuantity: '1', unitPrice }],
    }),
  }), { params: Promise.resolve({ id: input.itemId }) })
}

test('an exact schedule retry replays once and a changed payload refuses without a second audit', { skip: !DB }, async () => {
  const f = await fixture()
  const key = randomUUID()
  try {
    assert.equal((await post(f, key)).status, 201)
    assert.equal((await post(f, key)).status, 200)
    const changed = await post(f, key, '99.0000')
    assert.equal(changed.status, 409)
    assert.deepEqual(await changed.json(), { error: 'invalid_idempotency_key' })
    const counts = (await db.execute<{ schedules: number; audits: number }>(sql`
      select
        (select count(*)::int from item_price_schedules where org_id=${f.orgId} and id=${key}) as schedules,
        (select count(*)::int from audit_log where org_id=${f.orgId} and table_name='item_price_schedules' and row_id=${key}) as audits
    `)).rows[0]
    assert.deepEqual(counts, { schedules: 1, audits: 1 })
  } finally {
    await dropScratchOrgReporting(f.orgId)
  }
})

test('a foreign price level is refused before schedule or audit insertion', { skip: !DB }, async () => {
  const own = await fixture()
  const foreign = await fixture()
  const key = randomUUID()
  try {
    const response = await post({ ...own, priceLevelId: foreign.priceLevelId }, key)
    assert.equal(response.status, 400)
    assert.match(String((await response.json()).error), /not active in this organization/)
    const counts = (await db.execute<{ schedules: number; audits: number }>(sql`
      select
        (select count(*)::int from item_price_schedules where org_id=${own.orgId} and id=${key}) as schedules,
        (select count(*)::int from audit_log where org_id=${own.orgId} and table_name='item_price_schedules' and row_id=${key}) as audits
    `)).rows[0]
    assert.deepEqual(counts, { schedules: 0, audits: 0 })
  } finally {
    await dropScratchOrgReporting(own.orgId)
    await dropScratchOrgReporting(foreign.orgId)
  }
})
