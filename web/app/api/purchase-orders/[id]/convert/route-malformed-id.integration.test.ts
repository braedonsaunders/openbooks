import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../../../lib/auth'

// A malformed convert [id] must be a plain 404 on every order convert
// wrapper, never a uuid cast failure: the wrappers probe
// conversionWouldCopyInventoryKinds (which binds the raw id to a uuid
// column) before the shared handler's own isUuid check, so with Inventory
// off a non-uuid id died as a raw 500 instead of 404.
const root = pathToFileURL(process.cwd() + '/').href
const session: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __orderConvertMalformedSession: session })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === './auth' && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual(`export async function currentUser(){return globalThis.__orderConvertMalformedSession.user}`)
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST: postPurchase } = await import('./route')
const { POST: postSales } = await import('../../../sales-orders/[id]/convert/route')
const { POST: postEstimate } = await import('../../../estimates/[id]/convert/route')
const DB = !!process.env.OPENBOOKS_DB_URL

async function postConvert(
  post: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  orgId: string,
  id: string,
): Promise<{ status: number; json: unknown }> {
  try {
    const response = await withOrgContext(orgId, () =>
      post(
        new Request(`http://orders.test/api/convert/${id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ targetKind: 'vendor_bill' }),
        }),
        { params: Promise.resolve({ id }) },
      ),
    )
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

for (const [kind, post] of [
  ['purchase_order', postPurchase],
  ['sales_order', postSales],
  ['estimate', postEstimate],
] as const) {
  test(`convert ${kind} with a malformed id is 404, never a uuid cast failure`, { skip: !DB }, async () => {
    const org = await withBypassContext(() => createScratchOrg())
    try {
      const actor = await withBypassContext(() => createScratchUser(org.orgId, 'Order converter', 'reviewer'))
      await withBypassContext(() => db.execute(sql`
        update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`))
      session.user = {
        id: actor, orgId: org.orgId, name: 'Order converter', email: 'converter@scratch.test',
        roles: [], isSuperAdmin: false, envKind: 'production' as const,
        productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor,
      }
      // Orders on, Inventory EXPLICITLY off (it defaults on): the exact
      // shape that bound the raw id to the uuid column and died as a 500.
      await withBypassContext(() => db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features}',
          coalesce(settings->'features', '{}'::jsonb) || '{"orders":true,"inventory":false}'::jsonb)
        where id = ${org.orgId}`))
      const res = await postConvert(post, org.orgId, 'not-a-uuid')
      assert.equal(res.status, 404)
    } finally {
      session.user = null
      await dropScratchOrg(org.orgId)
    }
  })
}
