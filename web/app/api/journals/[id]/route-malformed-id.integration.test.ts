import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// journals/[id] binds the path id straight into its opening existence probe
// on all three verbs, so a malformed id escapes as a raw Postgres uuid throw
// (HTTP 500) instead of the same 404 an unknown id returns.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __journalIdState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === '../../../../lib/authz') return virtual(`
      export async function guardPermission() {
        const s = globalThis.__journalIdState;
        return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
      }
      export function guardSubsidiaryScope() { return null }
      export function subsidiariesInScope() { return true }
    `)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { GET, PATCH, DELETE } = await import('./route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  return org
}

async function call(verb: 'GET' | 'PATCH' | 'DELETE', id: string): Promise<{ status: number; json: unknown }> {
  const handler = verb === 'GET' ? GET : verb === 'PATCH' ? PATCH : DELETE
  try {
    const response = await withOrgContext(state.orgId, () => handler(
      new Request(`http://journals.test/api/journals/${id}`, {
        method: verb,
        headers: { 'content-type': 'application/json' },
        body: verb === 'GET' ? undefined : JSON.stringify({}),
      }),
      { params: Promise.resolve({ id }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

for (const verb of ['GET', 'PATCH', 'DELETE'] as const) {
  test(`${verb} returns 404 for a malformed journal id`, { skip: !DB }, async () => {
    const org = await fixture()
    try {
      const result = await call(verb, 'not-a-uuid')
      assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })

  test(`${verb} still returns 404 for an unknown journal id`, { skip: !DB }, async () => {
    const org = await fixture()
    try {
      const result = await call(verb, randomUUID())
      assert.equal(result.status, 404, JSON.stringify(result.json))
    } finally {
      await dropScratchOrg(org.orgId)
    }
  })
}
