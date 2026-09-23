import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// F-t04-015: GET /api/expenses/reports answers an empty-body 500 — the
// [id] route binds the id straight into a uuid comparison and PostgreSQL
// throws 22P02. A non-uuid id must resolve through the same typed
// not-found contract as an unknown id, on every method of the route.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __expenseIdState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    // The route reaches authz through lib/feature-gates' relative imports,
    // so match by suffix rather than by the route's own specifier.
    if (specifier === '../../../../lib/authz' || specifier === './authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__expenseIdState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: ['expenses.read', 'expenses.create', 'ap.post'], allowedSubsidiaryIds: null };
      }
      export function can(authz, permission) { return authz.permissions.includes(permission) }
      export async function guardPermission(permission) {
        const authz = await getAuthz();
        if (!authz.permissions.includes(permission)) throw new Error('test guard forbids ' + permission);
        return authz;
      }
      export function guardSubsidiaryScope() { return null }
    `)
    if (specifier === '../../../../lib/features' || specifier === './features') return virtual(`
      export async function isFeatureEnabled() { return true }
      export function featureEnabled() { return true }
      export async function orgFeatureState() { return {} }
      export async function checkProjectsWriteEnabled() { return true }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    // Pin the engine to THIS checkout: the environment shares node_modules
    // with the main checkout, so an unmapped @openbooks/engine import would
    // silently exercise main's engine instead of the branch under test.
    if (specifier.startsWith('@openbooks/engine/')) return next(root + specifier.slice('@openbooks/'.length), context)
    return next(specifier, context)
  },
})
const { withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, PATCH, DELETE } = await import('./route.ts')
// The route's web/lib chain (documents → org-scope → auth → request-org)
// registers the app RLS resolver at import time, replacing the preloaded
// trusted-test boundary for this process. Re-install the boundary AFTER the
// web imports so scratch fixtures keep their documented cross-org authority;
// the route calls under test scope themselves explicitly (withOrgContext)
// and are unaffected.
const { installTrustedTestDatabaseBypass } = await import('@openbooks/engine/src/testing/database-bypass.ts')
installTrustedTestDatabaseBypass()
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  return org
}

async function call(
  method: 'GET' | 'PATCH' | 'DELETE',
  id: string,
): Promise<{ status: number; json: unknown }> {
  const handler = method === 'GET' ? GET : method === 'PATCH' ? PATCH : DELETE
  const response = await withOrgContext(state.orgId, () =>
    handler(
      new Request(`http://expenses.test/api/expenses/${id}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({}),
      }),
      { params: Promise.resolve({ id }) },
    ),
  )
  return { status: response.status, json: await response.json().catch(() => null) }
}

for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
  test(`${method} answers a non-uuid id with the typed not-found contract`, { skip: !DB }, async () => {
    const org = await fixture()
    try {
      const result = await call(method, 'reports')
      assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
      assert.deepEqual(result.json, { error: 'not found' })
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
}
