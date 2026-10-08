import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import type { Authz } from './authz-core'
import { withAuthzContext } from './authz-context'

const stateKey = Symbol.for('openbooks.locale-tenant-scope-test')
const queries: { sql: string; params: unknown[] }[] = []
const dialect = new PgDialect()
const state = { orgReads: 0, userReads: 0, orgScopes: [] as string[], activeUser: null as { id: string; orgId: string } | null, locale: null as string | null, timeZone: null as string | null,
  execute(query: SQL) {
    const compiled = dialect.sqlToQuery(query)
    queries.push(compiled)
    state.orgReads++
    if (compiled.sql.includes('current_setting')) return { rows: [{ org_id: null }] }
    return { rows: [{ user_locale: state.locale, org_default: 'fr', time_zone: state.timeZone }] }
  },
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mocks = new Map([
  ['mock:headers', `export async function cookies() { throw new Error('no request context') }`],
  ['mock:auth', `export async function currentSession(){return null}; export async function currentUser(){const state=globalThis[Symbol.for('openbooks.locale-tenant-scope-test')];state.userReads++;return state.activeUser}`],
  ['mock:db', `const state=globalThis[Symbol.for('openbooks.locale-tenant-scope-test')]; export async function withBypassContext(work){return work()}; export async function withOrgContext(orgId,work){state.orgScopes.push(orgId);return work()}; export const db={async execute(query){return state.execute(query)}}`],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/headers') return { shortCircuit: true, url: 'mock:headers' }
    const owned = /\/web\/lib\/(locale|org-scope)\.ts$/.test(context.parentURL ?? '')
    if (specifier === './auth' && owned) return { shortCircuit: true, url: 'mock:auth' }
    if (specifier === '@openbooks/engine/src/platform/db.ts' && owned) return { shortCircuit: true, url: 'mock:db' }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url)
    return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true }
  },
})

const { resolveLocale, resolveTimeZone } = await import('./locale.ts')
const { DEFAULT_LOCALE } = await import('../i18n/config')
const { resolveOrgId } = await import('./org-scope.ts')
const principal = (orgId: string): Authz => ({ user: { orgId, id: `viewer-${orgId}` }, permissions: new Set(['reports.read']), allowedSubsidiaryIds: new Set([orgId]) }) as Authz
function reset() { state.orgReads = 0; state.userReads = 0; state.orgScopes.length = 0; queries.length = 0 }

test('locale resolution without an authenticated tenant never reads an arbitrary org setting', async () => {
  assert.deepEqual([await resolveLocale(), await resolveTimeZone()], [DEFAULT_LOCALE, 'UTC'])
  assert.equal(state.orgReads, 0)
})

test('locale and time zone follow the verified active tenant', async () => {
  reset()
  state.activeUser = { id: 'acting-user', orgId: 'switched-tenant' }
  state.locale = null; state.timeZone = 'Asia/Tokyo'
  assert.equal(await resolveLocale(), 'fr')
  assert.equal(await resolveTimeZone(), 'Asia/Tokyo')
  assert.deepEqual([state.orgReads, state.orgScopes], [2, ['switched-tenant']])
})

test('concurrent display consumers share facts only within their verified request', async () => {
  reset(); state.locale = 'ja'; state.timeZone = 'Asia/Tokyo'
  await withAuthzContext(principal('company-a'), async () => {
    const values = await Promise.all(Array.from({ length: 5 }, async () => [await resolveLocale(), await resolveTimeZone(), await resolveOrgId()]))
    assert.deepEqual(values, Array.from({ length: 5 }, () => ['ja', 'Asia/Tokyo', 'company-a']))
  })
  assert.equal(state.userReads, 0)
  assert.equal(state.orgReads, 2)
  assert.deepEqual(state.orgScopes, ['company-a'])
  assert.deepEqual(queries[0]?.params, ['viewer-company-a', 'company-a', 'company-a'])
  assert.match(queries[0]!.sql, /u\.is_active/)
})

test('fresh requests refresh display settings even when the caller reuses a principal', async () => {
  reset(); const verified = principal('company-a')
  state.locale = 'ja'; state.timeZone = 'Asia/Tokyo'
  assert.deepEqual(await withAuthzContext(verified, async () => [await resolveLocale(), await resolveTimeZone()]), ['ja', 'Asia/Tokyo'])
  state.locale = 'de'; state.timeZone = 'Europe/Berlin'
  assert.deepEqual(await withAuthzContext(verified, async () => [await resolveLocale(), await resolveTimeZone()]), ['de', 'Europe/Berlin'])
  assert.equal(state.orgReads, 4)
  assert.equal(state.userReads, 0)
})

test('overlapping tenant requests keep distinct display reads and organization identities', async () => {
  reset(); state.locale = null; state.timeZone = 'UTC'
  const result = await Promise.all(['company-a', 'company-b'].map(orgId => withAuthzContext(principal(orgId), async () => {
    await Promise.resolve()
    return [await resolveOrgId(), await resolveLocale(), await resolveTimeZone()]
  })))
  assert.deepEqual(result, [['company-a', 'fr', 'UTC'], ['company-b', 'fr', 'UTC']])
  assert.equal(state.orgReads, 4)
  assert.equal(state.userReads, 0)
  assert.deepEqual([...state.orgScopes].sort(), ['company-a', 'company-b'])
  assert.deepEqual(queries.filter(q => q.sql.includes('user_locale')).map(q => q.params[0]).sort(), ['viewer-company-a', 'viewer-company-b'])
})

test('invalid tenant time zones refuse all consumers and are retried by a fresh request', async () => {
  reset(); state.timeZone = 'invalid-zone'
  const verified = principal('company-a')
  await withAuthzContext(verified, async () => {
    const results = await Promise.allSettled([resolveTimeZone(), resolveTimeZone()])
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') assert.match(String(result.reason), /correct Company Settings/)
    }
  })
  assert.equal(state.orgReads, 1)
  state.timeZone = 'UTC'
  assert.equal(await withAuthzContext(verified, () => resolveTimeZone()), 'UTC')
  assert.equal(state.orgReads, 2)
})

test('trusted organization arguments remain explicit and unknown identities refuse', async () => {
  reset(); state.activeUser = null
  assert.equal(await withAuthzContext(principal('company-a'), () => resolveOrgId('trusted-job-org')), 'trusted-job-org')
  assert.equal(state.orgReads, 0)
  assert.equal(state.userReads, 0)
  await assert.rejects(() => resolveOrgId(), /active organization is required/)
  assert.equal(state.orgReads, 1)
})
