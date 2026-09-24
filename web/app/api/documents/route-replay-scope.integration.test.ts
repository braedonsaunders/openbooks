import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import type { SessionUser } from '../../../lib/auth'

/**
 * H-DOC-REPLAY: an idempotency-key replay returns the document's CURRENT
 * state — so a rehome since the create must not leak another subsidiary's
 * document through the replayed key. A restricted creator who replays a
 * key whose document now sits outside their scope meets the uniform
 * not-found; an in-scope replay still returns the row. Only the session
 * is stubbed; handler, idempotency matching and storage are real.
 */
const root = pathToFileURL(process.cwd() + '/').href
const state: { user: SessionUser | null } = { user: null }
Object.assign(globalThis, { __documentReplayScopeUser: state })
const virtual = (source: string) => ({ shortCircuit: true as const, url: 'data:text/javascript,' + encodeURIComponent(source) })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return virtual('export {}')
    if ((specifier === './auth' || specifier.endsWith('/lib/auth')) && context.parentURL?.endsWith('/web/lib/authz.ts')) {
      return virtual('export async function currentUser(){return globalThis.__documentReplayScopeUser.user}')
    }
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
    return next(specifier, context)
  },
})
const { db, withBypassContext, withOrgContext } = await import('@openbooks/engine/src/platform/db.ts')
const { sql } = await import('drizzle-orm')
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import('@openbooks/engine/src/testing/fixtures.ts')
const { POST } = await import('./route')
const DB = !!process.env.OPENBOOKS_DB_URL

function sessionUser(id: string, orgId: string): SessionUser {
  return {
    id, orgId, name: 'tester', email: `tester-${id.slice(0, 8)}@scratch.test`, roles: [],
    isSuperAdmin: false, envKind: 'production', productionOrgId: orgId,
    homeOrgId: orgId, homeUserId: id,
  }
}

const post = (body: unknown, key: string) =>
  POST(
    new Request('http://replay.test/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    }),
  )

test('a replayed key for a rehomed document answers as missing', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const branch = randomUUID()
    await withBypassContext(() => db.execute(sql`
      insert into subsidiaries
        (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${branch}, ${org.orgId}, ${org.subsidiaryId}, 'Replay Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`))
    const userId = await withBypassContext(() => createScratchUser(org.orgId, 'replay creator', 'replay_creator'))
    await withBypassContext(() => db.execute(sql`
      update app_roles
         set permissions = '["ap.read", "ap.create"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: 'list', subsidiaryIds: [org.subsidiaryId] })}::jsonb
       where org_id = ${org.orgId} and key = 'replay_creator'`))
    state.user = sessionUser(userId, org.orgId)

    const body = {
      kind: 'vendor_bill',
      partyId: org.vendorId,
      documentDate: org.date,
      lines: [{ accountId: org.accounts.cogs, amount: '50', description: 'Parts' }],
    }
    const key = randomUUID()
    const created = await withOrgContext(org.orgId, () => post(body, key).then(async (r) => ({
      status: r.status,
      json: (await r.json()) as Record<string, unknown>,
    })))
    assert.equal(created.status, 201, `restricted create must succeed: ${JSON.stringify(created.json)}`)

    // The bill moves to a subsidiary outside the creator's scope.
    await withBypassContext(() => db.execute(sql`
      update documents set subsidiary_id = ${branch}
       where id = ${key} and org_id = ${org.orgId}`))

    const replayed = await withOrgContext(org.orgId, () => post(body, key).then(async (r) => ({
      status: r.status,
      json: (await r.json()) as Record<string, unknown>,
    })))
    assert.equal(replayed.status, 404, 'an out-of-scope replay answers as missing')
    assert.deepEqual(replayed.json, { error: 'not found' })
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})

test('an in-scope replay still returns the row', { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg())
  try {
    const userId = await withBypassContext(() => createScratchUser(org.orgId, 'replay control', 'replay_control'))
    await withBypassContext(() => db.execute(sql`
      update app_roles set permissions = '["ap.read", "ap.create"]'::jsonb
       where org_id = ${org.orgId} and key = 'replay_control'`))
    state.user = sessionUser(userId, org.orgId)

    const body = {
      kind: 'vendor_bill',
      partyId: org.vendorId,
      documentDate: org.date,
      lines: [{ accountId: org.accounts.cogs, amount: '50', description: 'Parts' }],
    }
    const key = randomUUID()
    const created = await withOrgContext(org.orgId, () => post(body, key))
    assert.equal(created.status, 201)
    const replayed = await withOrgContext(org.orgId, () => post(body, key).then(async (r) => ({
      status: r.status,
      json: (await r.json()) as { doc: Record<string, unknown> },
    })))
    assert.equal(replayed.status, 200, 'an in-scope replay still returns the row')
    assert.equal(replayed.json.doc.id, key)
  } finally {
    state.user = null
    await withBypassContext(() => dropScratchOrg(org.orgId))
  }
})
