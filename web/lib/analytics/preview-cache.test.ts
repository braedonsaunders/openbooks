import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { Authz } from '../authz'
import type { AnalyticsPreview } from './dashboard-catalog'

const storage = new Map<string, { value: string; until: number }>()
let unavailable = false
const redis = {
  async get(key: string) {
    if (unavailable) throw new Error('cache transport unavailable')
    const entry = storage.get(key)
    return entry && entry.until > Date.now() ? entry.value : null
  },
  async incr(key: string) {
    const value = Number(await this.get(key) ?? 0) + 1
    storage.set(key, { value: String(value), until: Infinity })
    return value
  },
  async set(key: string, value: string, _px: string, lifetime: number, nx?: string) {
    if (nx && await this.get(key)) return null
    storage.set(key, { value, until: Date.now() + lifetime })
    return 'OK' as const
  },
  async eval(script: string, count: number, lease: string, ...args: (string | number)[]) {
    if (script.includes("redis.call('INCR'")) {
      const [key, lifetime] = args
      if (await this.set(lease, '1', 'PX', Number(lifetime), 'NX')) return this.incr(String(key))
      return Number(await this.get(String(key)) ?? 0)
    }
    if (script.includes("redis.call('PEXPIRE'")) {
      if (await this.get(lease) !== args[0]) return 0
      storage.set(lease, { value: String(args[0]), until: Date.now() + 90_000 })
      return 1
    }
    // The network double models Redis lease ownership; real Lua publication
    // is also exercised against an isolated Redis server during verification.
    const [keyOrToken, tokenOrValue, value, lifetime] = args
    const token = count === 2 ? tokenOrValue : keyOrToken
    if (await this.get(lease) !== token) return 0
    if (count === 2) storage.set(String(keyOrToken), { value: String(value), until: Date.now() + Number(lifetime) })
    storage.delete(lease)
    return 1
  },
}
Object.assign(globalThis, { __analyticsCacheTransport: redis })
const cacheModule = new URL('../../../packages/jobs/src/read-cache.ts', import.meta.url).href
registerHooks({ resolve(specifier, context, next) {
  let source: string | undefined
  if (specifier === '@openbooks/jobs/read-cache') source = `export * from ${JSON.stringify(cacheModule)}`
  if (specifier === 'next-intl/server') source = 'export async function getLocale(){return "en"} export async function getTranslations(){return (key) => key}'
  if (specifier === './connection' && context.parentURL?.endsWith('/jobs/src/read-cache.ts')) source = 'export async function getReadCacheConnection(){return globalThis.__analyticsCacheTransport}'
  return source ? { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(source) } : next(specifier, context)
} })
const { cachedAnalyticsPreview, invalidateAnalyticsPreviews, analyticsPreviewKey } = await import('./preview-cache')
const auth = (orgId: string, userId = 'operator'): Authz => ({ user: { orgId, id: userId }, permissions: new Set(['reports.read']), allowedSubsidiaryIds: null }) as Authz
const preview = (value: string): AnalyticsPreview => ({ periodLabel: 'FY 2026', metrics: [{ label: 'Invoices', value }], observedAt: new Date(Date.now()).toISOString() })
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

test('one thousand equally authorized users share one calculation', async () => {
  let calls = 0
  const results = await Promise.all(Array.from({ length: 1000 }, (_, index) => cachedAnalyticsPreview(auth('concurrent-company', `operator-${index}`), 'receivables', { period: 'fy' }, async () => {
    calls += 1; await delay(); return preview('42')
  })))
  assert.equal(calls, 1)
  assert.equal(results.length, 1000)
  assert.ok(results.every((result) => result.metrics[0]?.value === '42'))
})

test('tenant, legal-entity grants, permissions, locale and every source filter isolate results', () => {
  const principal = auth('scope-company')
  const key = (who = principal, query = { period: 'fy' }, locale = 'en') => analyticsPreviewKey(who, 'cashflow', query, locale, '1')
  const base = key()
  assert.notEqual(base, key(auth('other-company')))
  assert.notEqual(base, key({ ...principal, allowedSubsidiaryIds: new Set() }))
  assert.notEqual(base, key({ ...principal, allowedSubsidiaryIds: new Set(['entity-one']) }))
  assert.notEqual(base, key({ ...principal, permissions: new Set(['reports.read', 'payroll.read']) }))
  assert.notEqual(base, key(principal, { period: 'fy' }, 'fr'))
  assert.notEqual(base, analyticsPreviewKey(principal, 'cashflow', { period: 'fy', account: 'bank-one' }, 'en', '1'))
  assert.equal(key({ ...principal, allowedSubsidiaryIds: new Set(['b', 'a']) }), key({ ...principal, allowedSubsidiaryIds: new Set(['a', 'b']) }))
})

test('organization mutation invalidates its results without evicting another tenant', async () => {
  let calls = 0
  const load = async () => preview(String(++calls))
  const a = auth('changed-company'), b = auth('unchanged-company')
  assert.equal((await cachedAnalyticsPreview(a, 'receivables', {}, load)).metrics[0]!.value, '1')
  assert.equal((await cachedAnalyticsPreview(b, 'receivables', {}, load)).metrics[0]!.value, '2')
  await invalidateAnalyticsPreviews(a.user.orgId)
  assert.equal((await cachedAnalyticsPreview(a, 'receivables', {}, load)).metrics[0]!.value, '3')
  assert.equal((await cachedAnalyticsPreview(b, 'receivables', {}, load)).metrics[0]!.value, '2')
})

test('expired metrics are recalculated rather than silently served as current', async (t) => {
  const now = Date.now
  let clock = now(), calls = 0
  Date.now = () => clock
  t.after(() => { Date.now = now })
  const load = async () => preview(String(++calls))
  const principal = auth('expired-company')
  await cachedAnalyticsPreview(principal, 'receivables', {}, load)
  clock += 30_001
  assert.equal((await cachedAnalyticsPreview(principal, 'receivables', {}, load)).metrics[0]!.value, '2')
})

test('a source refusal reaches every waiter and is retried on the next read', async () => {
  let calls = 0
  const principal = auth('refused-company')
  const failure = new Error('Configure the statement book before calculating metrics.')
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => cachedAnalyticsPreview(principal, 'financial-health', {}, async () => { calls += 1; await delay(); throw failure })))
  assert.equal(calls, 1)
  assert.ok(results.every((result) => result.status === 'rejected' && result.reason === failure))
  assert.equal((await cachedAnalyticsPreview(principal, 'financial-health', {}, async () => preview('7'))).metrics[0]!.value, '7')
})

test('cache outage still coalesces reads and preserves local mutation invalidation', async (t) => {
  unavailable = true
  t.after(() => { unavailable = false })
  let calls = 0
  const principal = auth('offline-company')
  const load = async () => { calls += 1; await delay(); return preview(String(calls)) }
  await Promise.all(Array.from({ length: 100 }, () => cachedAnalyticsPreview(principal, 'receivables', {}, load)))
  assert.equal(calls, 1)
  await invalidateAnalyticsPreviews(principal.user.orgId)
  await cachedAnalyticsPreview(principal, 'receivables', {}, load)
  assert.equal(calls, 2)
})

test('different uncached cards never exceed four simultaneous source calculations', async () => {
  let active = 0, maximum = 0, calls = 0
  await Promise.all(Array.from({ length: 24 }, (_, index) => cachedAnalyticsPreview(auth('bounded-company'), `card-${index}`, {}, async () => {
    active += 1; calls += 1; maximum = Math.max(maximum, active)
    await delay(); active -= 1; return preview(String(index))
  })))
  assert.equal(calls, 24)
  assert.equal(maximum, 4)
})

test('a thousand transaction writes in one freshness window do not create a thousand cold calculations', async () => {
  let calls = 0
  const principal = auth('posting-company')
  const load = async () => preview(String(++calls))
  await cachedAnalyticsPreview(principal, 'receivables', {}, load)
  await invalidateAnalyticsPreviews(principal.user.orgId)
  await cachedAnalyticsPreview(principal, 'receivables', {}, load)
  for (let index = 0; index < 1000; index += 1) {
    await invalidateAnalyticsPreviews(principal.user.orgId)
    await cachedAnalyticsPreview(principal, 'receivables', {}, load)
  }
  assert.equal(calls, 2)
})
