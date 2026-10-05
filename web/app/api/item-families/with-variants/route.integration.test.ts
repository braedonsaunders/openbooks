import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test, { after } from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.with-variants-route-test')
const routeState: { authz: { user: { orgId: string; id: string }; allowedSubsidiaryIds: Set<string> | null } | null } = { authz: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/authz') return { shortCircuit: true, url: 'mock:with-variants-authz' }
    if (specifier === './authz' && context.parentURL?.endsWith('/web/lib/feature-gates.ts')) {
      return { shortCircuit: true, url: 'mock:with-variants-authz' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:with-variants-authz') {
      return {
        shortCircuit: true,
        format: 'module',
        source: `
          export async function guardPermission() {
            const state = globalThis[Symbol.for('openbooks.with-variants-route-test')]
            return state.authz ?? new Response(null, { status: 403 })
          }
          export function guardUnrestrictedScope() {
            return null
          }
        `,
      }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?with-variants-route-integration'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
after(() => hooks.deregister())

const { db, withBypassContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrgReporting, seedFlowActors } = await import('@openbooks/engine/src/testing/fixtures.ts')

async function fixture() {
  return withBypassContext(async () => {
    const org = await createScratchOrg()
    const actorId = (await seedFlowActors(org.orgId)).adminId
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"itemVariants":true}'::jsonb)
       where id = ${org.orgId}`)
    return { orgId: org.orgId, actorId }
  })
}

function post(input: { orgId: string; actorId: string }) {
  routeState.authz = { user: { orgId: input.orgId, id: input.actorId }, allowedSubsidiaryIds: null }
  const sizes = ['S', 'M']
  const colors = ['Red', 'Green', 'Blue']
  const variants = sizes.flatMap((size) => colors.map((color) => ({ optionValues: { Size: size, Color: color } })))
  return POST(new Request('http://openbooks.test/api/item-families/with-variants', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: 'TEE',
      name: 'Classic Tee',
      kind: 'inventory',
      defaultRate: '24.99',
      options: [
        { name: 'Size', values: sizes },
        { name: 'Color', values: colors },
      ],
      variants,
    }),
  }), { params: Promise.resolve({}) })
}

test('two options of 2x3 create six variants and one family in one request', async () => {
  const f = await fixture()
  try {
    const response = await post(f)
    assert.equal(response.status, 201)
    const body = await response.json() as { family: { id: string; code: string }; variants: { code: string }[] }
    assert.equal(body.family.code, 'TEE')
    assert.equal(body.variants.length, 6)
    const counts = await withBypassContext(async () => (await db.execute<{ families: string; items: string }>(sql`
      select (select count(*)::text from item_families where org_id = ${f.orgId} and code = 'TEE') as families,
             (select count(*)::text from items where org_id = ${f.orgId} and family_id = ${body.family.id}) as items`)).rows[0])
    assert.equal(counts?.families, '1')
    assert.equal(counts?.items, '6')
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(f.orgId))
  }
})

test('creation hides when the variants gate is off and keeps the data', async () => {
  const f = await fixture()
  try {
    await withBypassContext(async () => {
      await db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"itemVariants":false}'::jsonb)
         where id = ${f.orgId}`)
    })
    const response = await post(f)
    assert.equal(response.status, 404)
    const rows = await withBypassContext(async () =>
      (await db.execute<{ count: string }>(sql`select count(*)::text as count from item_families where org_id = ${f.orgId}`)).rows[0])
    assert.equal(rows?.count, '0')
  } finally {
    await withBypassContext(() => dropScratchOrgReporting(f.orgId))
  }
})
