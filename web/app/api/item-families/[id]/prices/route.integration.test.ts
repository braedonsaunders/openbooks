import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test, { after } from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.family-prices-route-test')
const routeState: { authz: { user: { orgId: string; id: string }; allowedSubsidiaryIds: Set<string> | null } | null } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/authz') return { shortCircuit: true, url: 'mock:family-price-authz' }
    // defineRoute's string-feature branch guards through ./authz as imported
    // by feature-gates: the same stub stands in there, while the real
    // isFeatureEnabled still reads the org's stored settings.
    if (specifier === './authz' && context.parentURL?.endsWith('/web/lib/feature-gates.ts')) {
      return { shortCircuit: true, url: 'mock:family-price-authz' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:family-price-authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
          export async function guardPermission() {
            const state = globalThis[Symbol.for('openbooks.family-prices-route-test')]
            return state.authz ?? new Response(null, { status: 403 })
          }
          export async function getAuthz() {
            return globalThis[Symbol.for('openbooks.family-prices-route-test')].authz ?? null
          }
          export function guardUnrestrictedScope() {
            return null
          }
          export async function guardRootSubsidiaryScope() {
            return null
          }
        `,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?family-prices-route-integration'
const { GET, POST } = (await import(routeUrl)) as typeof import('./route.ts')
after(() => hooks.deregister())

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { createItemFamily, generateFamilyVariants } = await import('@openbooks/engine/src/inventory/item-families.ts')
const { resolveItemPrice } = await import('../../../../../lib/item-pricing.ts')

async function fixture() {
  return withBypassContext(async () => {
    const org = await createScratchOrg()
    const actorId = (await seedFlowActors(org.orgId)).adminId
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"itemVariants":true}'::jsonb)
       where id = ${org.orgId}`)
    const currency = (await db.execute<{ base_currency: string }>(sql`select base_currency from orgs where id = ${org.orgId}`)).rows[0]!.base_currency
    const baseLevel = (await db.execute<{ id: string }>(sql`select id from price_levels where org_id = ${org.orgId} and is_base and is_active`)).rows[0]!
    const family = await createItemFamily(org.orgId, actorId, {
      code: 'TEE', name: 'Classic Tee', kind: 'inventory', defaultUnit: 'each', defaultRate: '24.99',
      options: [{ name: 'Size', values: ['S', 'M'] }],
    })
    const generated = await generateFamilyVariants(org.orgId, actorId, family.id)
    return { orgId: org.orgId, actorId, currency, baseLevelId: baseLevel.id, familyId: family.id, variantId: generated.variants[0]!.id }
  })
}

function post(input: { orgId: string; actorId: string; familyId: string; baseLevelId: string; currency: string }, key: string, unitPrice = '20.0000') {
  routeState.authz = { user: { orgId: input.orgId, id: input.actorId }, allowedSubsidiaryIds: null }
  return POST(new Request(`http://openbooks.test/api/item-families/${input.familyId}/prices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({
      priceLevelId: input.baseLevelId,
      currency: input.currency,
      quantityBasis: 'line_quantity',
      effectiveFrom: '2026-09-22',
      breaks: [{ minimumQuantity: '1', unitPrice }],
    }),
  }), { params: Promise.resolve({ id: input.familyId }) })
}

async function get(input: { orgId: string; actorId: string; familyId: string }) {
  routeState.authz = { user: { orgId: input.orgId, id: input.actorId }, allowedSubsidiaryIds: null }
  try {
    return await GET(new Request(`http://openbooks.test/api/item-families/${input.familyId}/prices`), { params: Promise.resolve({ id: input.familyId }) })
  } finally {
    routeState.authz = null
  }
}

test('a family schedule posts once and prices every variant', async () => {
  const f = await fixture()
  try {
    const created = await post(f, randomUUID())
    assert.equal(created.status, 201)
    const listed = await get(f)
    assert.equal(listed.status, 200)
    const body = await listed.json() as { schedules: { id: string; breaks: { unitPrice: string }[] }[] }
    assert.equal(body.schedules.length, 1)
    assert.equal(body.schedules[0]!.breaks[0]!.unitPrice, '20.0000')
    const price = await withBypassContext(() => resolveItemPrice({
      orgId: f.orgId, itemId: f.variantId, customerId: null,
      currency: f.currency, lineQuantity: '1', onDate: '2026-10-01',
    }))
    assert.equal(price?.unitPrice, '20.0000')
    assert.equal(price?.source, 'family_base_level')
    assert.equal(price?.familyName, 'Classic Tee')
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(f.orgId))
  }
})

test('an overlapping family schedule is refused with a reload remedy', async () => {
  const f = await fixture()
  try {
    assert.equal((await post(f, randomUUID())).status, 201)
    const clashing = await post(f, randomUUID(), '21.0000')
    assert.equal(clashing.status, 409)
    assert.match(String((await clashing.json()).error), /already covers that scope/)
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(f.orgId))
  }
})

test('family pricing hides when the variants gate is off', async () => {
  const f = await fixture()
  try {
    await withBypassContext(async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"itemVariants":false}'::jsonb)
         where id = ${f.orgId}`)
    })
    assert.equal((await get(f)).status, 404)
    assert.equal((await post(f, randomUUID())).status, 404)
    const rows = await withBypassContext(async () =>
      (await db.execute<{ count: string }>(sql`select count(*)::text as count from item_price_schedules where org_id = ${f.orgId}`)).rows[0])
    assert.equal(rows?.count, '0')
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(f.orgId))
  }
})
