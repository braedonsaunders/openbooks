import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { createScratchOrg, dropScratchOrg, seedFlowActors } from '@openbooks/engine/src/testing/fixtures.ts'
import type { Authz } from '../../../../lib/authz'

// Reconciliation start must validate what it stores. POST requires all three
// fields but forwards a malformed accountId straight into the reconcilable-
// account lookup, where it dies as an unhandled uuid 22P02 throw (HTTP 500)
// instead of a domain 4xx. Only identity is substituted; feature checks,
// routes, domain services and SQL are native.
const enabled = !!process.env.OPENBOOKS_DB_URL
const identity: { gate: Authz | null } = { gate: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.recon-start-validation')] = identity
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/api/json') return next(new URL('../../../../lib/api/json.ts', import.meta.url).href, context)
  if (specifier === 'server-only') return { shortCircuit: true, url: 'data:text/javascript,export {}' }
  if (specifier === './authz' && (context.parentURL ?? '').endsWith('/lib/feature-gates.ts')) {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(
      "export async function guardPermission(){return globalThis[Symbol.for('openbooks.recon-start-validation')].gate}") }
  }
  return next(specifier, context)
} })
const { POST } = await import('./route')

async function fixture() {
  const org = await createScratchOrg()
  const actorId = (await seedFlowActors(org.orgId)).adminId
  await db.execute(sql`update orgs set settings=jsonb_set(settings,'{features}',
    coalesce(settings->'features','{}'::jsonb)||'{\"banking\":true}'::jsonb) where id=${org.orgId}`)
  await db.execute(sql`update accounts set reconcilable=true,currency_restriction='CAD'
    where org_id=${org.orgId} and id=${org.accounts.bank}`)
  identity.gate = { user: { orgId: org.orgId, id: actorId }, permissions: new Set(['*']), allowedSubsidiaryIds: null } as Authz
  return { ...org, actorId }
}

const post = (body: Record<string, unknown>) =>
  POST(new Request('https://openbooks.test/api/banking/reconciliations', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))

test('reconciliation start refuses a malformed account id with a domain error', { skip: !enabled }, async () => {
  const org = await fixture()
  try {
    const refused = await post({ accountId: 'not-a-uuid', throughDate: org.date, statementBalance: '100' })
    assert.ok(
      refused.status === 400 || refused.status === 422,
      `expected a domain 4xx, got ${refused.status}: ${JSON.stringify(await refused.json())}`,
    )
    const sessions = (await db.execute<{ n: number }>(sql`select count(*)::int as n from reconciliations where org_id=${org.orgId}`)).rows[0]!.n
    assert.equal(sessions, 0, 'refused starts open nothing')
    // A well-formed unknown account still fails closed at the service, and a
    // real reconcilable account still starts.
    const unknown = await post({ accountId: '00000000-0000-4000-8000-000000000000', throughDate: org.date, statementBalance: '100' })
    assert.equal(unknown.status, 422, JSON.stringify(await unknown.json()))
    const started = await post({ accountId: org.accounts.bank, throughDate: org.date, statementBalance: '100' })
    assert.equal(started.status, 200, `valid start must stay green: ${JSON.stringify(await started.json())}`)
  } finally {
    identity.gate = null
    await dropScratchOrg(org.orgId)
  }
})
