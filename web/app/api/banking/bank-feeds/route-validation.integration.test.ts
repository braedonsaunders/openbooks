import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/test-fixtures.ts'
import type { Authz } from '../../../../lib/authz'

// Bank-feed write paths must validate what they store. POST requires a
// non-empty name and allowlists the provider, but PATCH stored any name —
// including '' — and BOTH paths stored an arbitrary syncCadence string, which
// only fails later as an unhandled CHECK-violation 500. Only identity is
// substituted; feature checks, routes, domain services and SQL are native.
const enabled = !!process.env.OPENBOOKS_DB_URL
const identity: { gate: Authz | null } = { gate: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.bank-feed-validation')] = identity
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/api/json') return next(new URL('../../../../lib/api/json.ts', import.meta.url).href, context)
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './authz' && (context.parentURL ?? '').endsWith('/lib/feature-gates.ts')) {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
      "export async function guardPermission(){return globalThis[Symbol.for('openbooks.bank-feed-validation')].gate}") }
  }
  return next(specifier, context)
} })
const { POST } = await import('./route')
const { PATCH } = await import('./[id]/route')

async function fixture() {
  const org = await createScratchOrg()
  const actorId = (await seedFlowActors(org.orgId)).adminId
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{"bankFeeds":true}'::jsonb) where id=${org.orgId}`)
  await db.execute(sql`update accounts set reconcilable=true,currency_restriction='CAD'
    where org_id=${org.orgId} and id=${org.accounts.bank}`)
  identity.gate = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null } as Authz
  return { ...org, actorId }
}

const { DELETE } = await import('./[id]/route')
const post = (body: Record<string, unknown>) =>
  POST(new Request('https://openbooks.test/api/banking/bank-feeds', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
const patch = (id: string, body: Record<string, unknown>) =>
  PATCH(new Request(`https://openbooks.test/api/banking/bank-feeds/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id }) })
const remove = (id: string) =>
  DELETE(new Request(`https://openbooks.test/api/banking/bank-feeds/${id}`, { method: 'DELETE' }), {
    params: Promise.resolve({ id }),
  })

async function feedRow(orgId: string, id: string) {
  return (await db.execute<{ name: string; sync_cadence: string }>(sql`
    select name, sync_cadence from bank_feed_connections where org_id=${orgId} and id=${id}`)).rows[0]!
}

test('bank-feed PATCH rejects an empty name that POST refuses', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    const refused = await post({ name: '  ', provider: 'manual', accountId: org.accounts.bank })
    assert.equal(refused.status, 400)
    const created = await post({ name: 'Operating feed', provider: 'manual', accountId: org.accounts.bank })
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()))
    const { id } = (await created.json()) as { id: string }
    const patched = await patch(id, { name: '' })
    assert.equal(patched.status, 400, 'PATCH must enforce the same non-empty name as POST')
    assert.equal((await feedRow(org.orgId, id)).name, 'Operating feed')
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

test('bank-feed POST rejects a non-string name instead of throwing', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    const refused = await post({ name: 123, provider: 'manual', accountId: org.accounts.bank })
    assert.equal(refused.status, 400)
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

test('bank-feed POST rejects a syncCadence outside the stored check constraint', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    const refused = await post({
      name: 'API feed',
      provider: 'plaid',
      accountId: org.accounts.bank,
      externalAccountId: 'plaid-acct-1',
      syncCadence: 'weekly',
      credentials: { accessToken: 'test-token' },
    })
    assert.equal(refused.status, 400, JSON.stringify(await refused.clone().json()))
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

test('bank-feed routes reject malformed ids as client errors', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    for (const id of ['not-a-uuid', 'new']) {
      assert.equal((await patch(id, { name: 'Renamed' })).status, 404, `PATCH ${id}`);
      assert.equal((await remove(id)).status, 404, `DELETE ${id}`);
    }
    const refused = await post({ name: 'Bad account feed', provider: 'manual', accountId: 'not-a-uuid' })
    assert.equal(refused.status, 400, JSON.stringify(await refused.clone().json()))
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

// F-t11-005: the picker and the API must agree on what a feed can attach
// to — a reconcilable BANK account. A reconcilable non-bank account (or an
// inactive one) used to sail through POST and strand statements where no
// banking surface can reconcile them.
test('bank-feed POST refuses a reconcilable non-bank account', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    await db.execute(sql`update accounts set reconcilable=true,currency_restriction='CAD'
      where org_id=${org.orgId} and id=${org.accounts.clearing}`)
    const refused = await post({ name: 'Clearing feed', provider: 'manual', accountId: org.accounts.clearing })
    assert.equal(refused.status, 400, JSON.stringify(await refused.clone().json()))
    assert.deepEqual(await refused.json(), { error: 'not a reconcilable account' })
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

test('bank-feed POST refuses an inactive reconcilable bank account', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    await db.execute(sql`update accounts set is_active=false where org_id=${org.orgId} and id=${org.accounts.bank}`)
    const refused = await post({ name: 'Dead feed', provider: 'manual', accountId: org.accounts.bank })
    assert.equal(refused.status, 400, JSON.stringify(await refused.clone().json()))
    assert.deepEqual(await refused.json(), { error: 'not a reconcilable account' })
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})

test('bank-feed writes reject a syncCadence outside the stored check constraint', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    const created = await post({ name: 'Operating feed', provider: 'manual', accountId: org.accounts.bank })
    assert.equal(created.status, 201, JSON.stringify(await created.clone().json()))
    const { id } = (await created.json()) as { id: string }
    // 'weekly' violates bank_feed_connections_cadence (manual/hourly/daily).
    // It must be a 4xx, never an unhandled CHECK-violation 500.
    const patched = await patch(id, { syncCadence: 'weekly' })
    assert.equal(patched.status, 400, JSON.stringify(await patched.clone().json()))
    assert.equal((await feedRow(org.orgId, id)).sync_cadence, 'manual')
  } finally { identity.gate = null; await dropScratchOrg(org.orgId) }
})
