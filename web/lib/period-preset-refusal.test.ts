import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// E34: a stale period preset id (saved before the preset was removed from the
// catalog) must refuse by name — never silently become This Fiscal Year and
// widen (or move) the report window.
const stateKey = Symbol.for('openbooks.period-preset-refusal-test')
const hookState: { dbCalls: number; periodRows: { name: string; starts_on: string; ends_on: string }[] } = { dbCalls: 0, periodRows: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = hookState

const TODAY = '2026-09-24'

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `const state = globalThis[Symbol.for('openbooks.period-preset-refusal-test')]
     export const db = { async execute() { state.dbCalls += 1; return { rows: state.periodRows } } }`,
  ],
  [
    'mock:org-scope',
    `export async function resolveOrgId(orgId) { if (orgId) return orgId; throw new Error('active organization is required') }`,
  ],
  ['mock:business-date', `export async function businessToday() { return '${TODAY}' }`],
  [
    'mock:fiscal',
    `export async function fiscalStartMonth() { return 1 }
     export async function defaultFiscalCalendarPeriods() { return null }`,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['./org-scope', 'mock:org-scope'],
  ['./fiscal', 'mock:fiscal'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const periodsUrl = './periods.ts?period-preset-refusal-test'
const { resolvePeriod } = (await import(periodsUrl)) as typeof import('./periods.ts')
hooks.deregister()

const ORG = 'org-1'

test('a stale preset id refuses by name instead of becoming This Fiscal Year', async () => {
  hookState.dbCalls = 0
  await assert.rejects(
    resolvePeriod('fiscal_yesterdecade', { orgId: ORG, today: TODAY }),
    (error: unknown) => {
      const message = (error as Error).message
      return message.includes('fiscal_yesterdecade') && message.includes('no longer exists')
    },
  )
  assert.equal(hookState.dbCalls, 0, 'a stale preset must refuse before any database work')
})

test('an absent preset still resolves the default fiscal year', async () => {
  for (const preset of [null, undefined, '']) {
    const resolved = await resolvePeriod(preset, { orgId: ORG, today: TODAY })
    assert.equal(resolved.presetId, 'this_fiscal_year')
    assert.equal(resolved.from, '2026-01-01')
    assert.equal(resolved.to, '2026-12-31')
  }
})

test('a current preset still resolves', async () => {
  const resolved = await resolvePeriod('today', { orgId: ORG, today: TODAY })
  assert.equal(resolved.presetId, 'today')
  assert.equal(resolved.from, TODAY)
  assert.equal(resolved.to, TODAY)
})

test('a business day before every configured accounting period refuses by name', async () => {
  hookState.periodRows = [
    { name: 'FY 2027 period 1', starts_on: '2026-04-01', ends_on: '2026-04-30' },
  ]
  await assert.rejects(
    resolvePeriod('this_period', { orgId: ORG, today: '2026-01-15' }),
    /2026-01-15.*precedes.*FY 2027 period 1/,
  )
  hookState.periodRows = []
})
