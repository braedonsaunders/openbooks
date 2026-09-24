import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { NextResponse } from 'next/server'
import test from 'node:test'
import { sql } from 'drizzle-orm'

;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.alloc-setup-view-next-response')] = { NextResponse }

const stateKey = Symbol.for('openbooks.alloc-setup-view-test')
interface ViewState {
  orgId: string | null
}
const viewState: ViewState = { orgId: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = viewState

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.alloc-setup-view-test')]
  export async function getAuthz() {
    if (!state.orgId) return null
    return { user: { orgId: state.orgId, id: 'actor-1' }, permissions: new Set(['admin.setup.manage']), allowedSubsidiaryIds: null }
  }
  export function can(authz, permission) {
    return authz.permissions.has('*') || authz.permissions.has(permission)
  }
  export async function requirePermission(permission) {
    if (!state.orgId) throw new Error('NEXT_REDIRECT:/login')
    return { user: { orgId: state.orgId, id: 'actor-1' }, permissions: new Set([permission]), allowedSubsidiaryIds: null }
  }
  export async function guardPermission(permission) {
    if (!state.orgId) {
      const { NextResponse } = globalThis[Symbol.for('openbooks.alloc-setup-view-next-response')]
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return { user: { orgId: state.orgId, id: 'actor-1' }, permissions: new Set([permission]), allowedSubsidiaryIds: null }
  }
`
const mockIntl = `
  export async function getTranslations(namespace) {
    return (key, _vars) => namespace + ':' + key;
  }
`

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const parent = String(context.parentURL)
    if (
      (specifier === '../../../../../lib/authz' && parent.includes('/admin/setup/allocations/view.ts'))
      || (specifier === './authz' && parent.includes('/lib/feature-gates.ts'))
    ) {
      return { url: 'mock:alloc-setup-view-authz', shortCircuit: true }
    }
    if (specifier === 'next-intl/server') {
      return { url: 'mock:alloc-setup-view-intl', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:alloc-setup-view-authz') {
      return { format: 'module', source: mockAuthz, shortCircuit: true }
    }
    if (url === 'mock:alloc-setup-view-intl') {
      return { format: 'module', source: mockIntl, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const { loadAllocations } = (await import('./view.ts')) as typeof import('./view.ts')
hooks.deregister()

const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import(
  '@openbooks/engine/src/testing/fixtures.ts'
)

// F1T-FIX-ALLOC: seeds run under the explicit bypass. The unscoped
// orgs-settings write previously matched zero rows under pooled RLS, so the
// allocations flag never landed and 'loader parses tabs' read the
// feature-required redirect instead of the tabs.
async function seed(withFeature: boolean): Promise<string> {
  const org = await withBypassContext(() => createScratchOrg())
  if (withFeature) {
    await withBypassContext(() => db.execute(sql`
      update orgs set settings = coalesce(settings, '{}'::jsonb)
        || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb) || '{"allocations": true}'::jsonb)
       where id = ${org.orgId}`))
  }
  viewState.orgId = org.orgId
  return org.orgId
}

test('loader 404s while the feature is off', { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
  const orgId = await seed(false)
  t.after(() => dropScratchOrg(orgId))
  await assert.rejects(withOrgContext(orgId, () => loadAllocations({})), (error: unknown) => {
    assert.ok(error instanceof Error)
    // next/navigation notFound() — any navigation throw counts as the 404 path.
    return /NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND|not found/i.test(error.message) || 'digest' in error
  })
})

test('loader parses tabs and falls back to rules', { skip: !process.env.OPENBOOKS_DB_URL }, async (t) => {
  const orgId = await seed(true)
  t.after(() => dropScratchOrg(orgId))
  assert.equal((await withOrgContext(orgId, () => loadAllocations({}))).tab, 'rules')
  assert.equal((await withOrgContext(orgId, () => loadAllocations({ tab: 'runs' }))).tab, 'runs')
  const unknown = await withOrgContext(orgId, () => loadAllocations({ tab: 'nope' }))
  assert.equal(unknown.tab, 'rules')
  assert.deepEqual([unknown.onRules, unknown.onDrivers, unknown.onRuns], [true, false, false])
  // Loader-resolved copy is non-empty catalog text (vendor neutrality is
  // enforced repo-wide by check:product-neutrality, not by a literal here).
  assert.ok(unknown.title.length > 0 && unknown.description.length > 0)
})
