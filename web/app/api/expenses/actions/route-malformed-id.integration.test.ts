import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// Malformed document ids must resolve through the same not-found contract as
// unknown ids. Without the UUID gate the id binds straight into the lookup
// and PostgreSQL answers 22P02, which the route's catch maps to a 500.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __expenseActionsIdState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function getAuthz() {
        const s = globalThis.__expenseActionsIdState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: ['expenses.create', 'ap.post'], allowedSubsidiaryIds: null };
      }
      export function can(authz, permission) { return authz.permissions.includes(permission) }
      export function guardSubsidiaryScope() { return null }
    `)
    if (specifier === '../../../../lib/features') return virtual(`
      export async function isFeatureEnabled() { return true }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    // Pin the engine to THIS checkout: the environment shares node_modules
    // with the main checkout, so an unmapped @openbooks/engine import would
    // silently exercise main's engine instead of the branch under test.
    if (specifier.startsWith('@openbooks/engine/')) return next(root + specifier.slice('@openbooks/'.length), context)
    return next(specifier, context)
  },
})
const { withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await withBypassContext(() => createScratchOrg())
  state.orgId = org.orgId
  state.actorId = randomUUID()
  return org
}

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await withOrgContext(state.orgId, () => POST(
    new Request('http://expenses.test/api/expenses/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  ))
  return { status: response.status, json: await response.json().catch(() => null) }
}

test('submit returns 404 for a malformed expense report id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await post({ action: 'submit', documentId: 'not-a-uuid' })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('post returns 404 for a malformed expense report id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await post({ action: 'post', documentId: 'not-a-uuid' })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('unknown ids still return the not-found contract', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const submit = await post({ action: 'submit', documentId: randomUUID() })
    assert.equal(submit.status, 404, JSON.stringify(submit.json))
    const postResult = await post({ action: 'post', documentId: randomUUID() })
    assert.equal(postResult.status, 404, JSON.stringify(postResult.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
