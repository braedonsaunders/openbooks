import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

// The platform-connections [id] family resolves the path id without gating
// it: PATCH/DELETE/run/test/qwc bind it straight into the connection lookup
// and a malformed id escapes as a raw Postgres uuid throw (HTTP 500) instead
// of the same 404 an unknown id returns.
const root = pathToFileURL(process.cwd() + '/').href
const state: { orgId: string; actorId: string } = { orgId: '', actorId: '' }
Object.assign(globalThis, { __platformConnIdState: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
const AUTHZ = `
  export async function guardPermission() {
    const s = globalThis.__platformConnIdState;
    return { user: { orgId: s.orgId, id: s.actorId }, permissions: [], allowedSubsidiaryIds: null };
  }
`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier.endsWith('/lib/authz')) return virtual(AUTHZ)
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { createScratchOrg, dropScratchOrg } = await import('@openbooks/engine/src/testing/fixtures.ts')
const { PATCH, DELETE } = await import('./route.ts')
const { POST: runPost } = await import('./run/route.ts')
const { POST: testPost } = await import('./test/route.ts')
const { GET: qwcGet } = await import('./qwc/route.ts')
const { POST: deletionsPost } = await import('./source-deletions/[ref]/route.ts')
const DB = !!process.env.OPENBOOKS_DB_URL

async function fixture() {
  const org = await createScratchOrg()
  state.orgId = org.orgId
  state.actorId = randomUUID()
  return org
}

type Handler = (req: Request, ctx: { params: Promise<{ id: string; ref: string }> }) => Promise<Response>

async function call(handler: Handler, method: string, params: { id: string; ref?: string }, body?: unknown): Promise<{ status: number; json: unknown }> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } }
  if (body !== undefined) init.body = JSON.stringify(body)
  try {
    const response = await withOrgContext(state.orgId, () => handler(
      new Request('http://platform.test/api/platform/connections/x', init),
      { params: Promise.resolve({ id: params.id, ref: params.ref ?? '' }) },
    ))
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 500, json: { thrown: error instanceof Error ? error.message : String(error) } }
  }
}

const MALFORMED = 'not-a-uuid'

test('PATCH returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(PATCH, 'PATCH', { id: MALFORMED }, {})
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('DELETE returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(DELETE, 'DELETE', { id: MALFORMED })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('run returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(runPost, 'POST', { id: MALFORMED }, { mode: 'mirror' })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('test returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(testPost, 'POST', { id: MALFORMED })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('qwc returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(qwcGet, 'GET', { id: MALFORMED })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('source-deletions returns 404 for a malformed connection id', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const result = await call(deletionsPost, 'POST', { id: MALFORMED, ref: 'x' }, { action: 'retain' })
    assert.equal(result.status, 404, `expected 404, got ${result.status}: ${JSON.stringify(result.json)}`)
  } finally {
    await dropScratchOrg(org.orgId)
  }
})

test('unknown ids still return the not-found contract', { skip: !DB }, async () => {
  const org = await fixture()
  try {
    const patched = await call(PATCH, 'PATCH', { id: randomUUID() }, {})
    assert.equal(patched.status, 404, JSON.stringify(patched.json))
    const ran = await call(runPost, 'POST', { id: randomUUID() }, { mode: 'mirror' })
    assert.equal(ran.status, 404, JSON.stringify(ran.json))
  } finally {
    await dropScratchOrg(org.orgId)
  }
})
