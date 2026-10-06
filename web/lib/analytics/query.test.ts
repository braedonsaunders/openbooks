import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'
import type { Authz } from '../authz'

const state = { calls: 0, active: 0, maximum: 0, refuse: false }
Object.assign(globalThis, { __analyticsQueryTransport: state })
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@openbooks/engine/platform/database' && context.parentURL?.endsWith('/analytics/query.ts')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
    export const db = { async execute() {
      const state = globalThis.__analyticsQueryTransport;
      state.calls++; state.active++; state.maximum = Math.max(state.maximum, state.active);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        if (state.refuse) throw new Error('Configure the statement book before reading this period.');
        return { rows: [{ amount: '9007199254740993.0001', at: new Date('2026-07-31T00:00:00Z'), count: 9007199254740993n }] };
      } finally { state.active--; }
    } };
  `) }
  if (specifier === './connection' && context.parentURL?.endsWith('/jobs/src/read-cache.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function getReadCacheConnection(){return undefined}' }
  return next(specifier, context)
} })
const { analyticsQuery } = await import('./query')
const { withAnalyticsRead } = await import('./read-context')
const auth = (orgId: string, allowed: ReadonlySet<string> | null = null, permission = 'reports.read'): Authz => ({ user: { orgId, id: 'operator' }, permissions: new Set([permission]), allowedSubsidiaryIds: allowed }) as Authz
const read = <T>(authority: Authz, slug: string, action: () => Promise<T>, revision = 'unit') => withAnalyticsRead({ authz: authority, slug, projection: slug === 'preview' ? 'summary' : 'tab', tab: 'overview', locale: 'en', revision, observedAt: Date.now() }, action)

test('one thousand card and tab readers share exact typed source facts without sharing mutable results', async () => {
  state.calls = 0
  const values = await Promise.all(Array.from({ length: 1000 }, (_, i) => read(auth('query-shared'), i % 2 ? 'preview' : 'cashflow', () => analyticsQuery(sql`select ${'query-shared'} as org`))))
  assert.equal(state.calls, 1)
  assert.equal(values.length, 1000)
  assert.equal(values[0]!.rows[0]!.amount, '9007199254740993.0001')
  assert.equal(values[0]!.rows[0]!.count, 9007199254740993n)
  assert.ok(values[0]!.rows[0]!.at instanceof Date)
  values[0]!.rows[0]!.amount = 'changed'
  assert.equal(values[1]!.rows[0]!.amount, '9007199254740993.0001')
})

test('source facts isolate organization, legal-entity grants, permissions, filters and revision', async () => {
  state.calls = 0
  const query = sql`select ${'scoped-query'} as source`
  for (const authority of [auth('query-scope'), auth('query-other'), auth('query-scope', new Set()), auth('query-scope', new Set(['entity'])), auth('query-scope', null, 'admin.audit.read')]) await read(authority, 'preview', () => analyticsQuery(query))
  await read(auth('query-scope'), 'cashflow', () => analyticsQuery(sql`select ${'other-source'} as source`))
  await read(auth('query-scope'), 'cashflow', () => analyticsQuery(query), 'changed')
  assert.equal(state.calls, 7)
})

test('cold SQL aggregate work is bounded across independent dashboard reads', async () => {
  state.calls = 0; state.maximum = 0
  await Promise.all(Array.from({ length: 32 }, (_, i) => read(auth('query-bounds'), 'cashflow', () => analyticsQuery(sql`select ${i} as source`))))
  assert.equal(state.calls, 32)
  assert.equal(state.maximum, 8)
  assert.equal(state.active, 0)
})

test('a refused source reaches every reader and the next request can retry it', async () => {
  state.calls = 0; state.refuse = true
  const action = () => read(auth('query-refusal'), 'cashflow', () => analyticsQuery(sql`select ${'refused-source'} as source`))
  const results = await Promise.allSettled(Array.from({ length: 20 }, action))
  state.refuse = false
  assert.equal(state.calls, 1)
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.message === 'Configure the statement book before reading this period.'))
  const retried = await action()
  assert.equal(state.calls, 2)
  assert.equal(retried.rows[0]!.amount, '9007199254740993.0001')
})


test('bigint binds are supported and remain distinct from text and numeric binds', async () => {
  state.calls = 0
  for (const value of [9007199254740993n, '9007199254740993', 1, '1']) {
    await read(auth('query-bind-types'), 'preview', () => analyticsQuery(sql`select ${value} as bound_value`))
  }
  assert.equal(state.calls, 4)
})
