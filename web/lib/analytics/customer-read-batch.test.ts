import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'

const org = '00000000-0000-4000-8000-000000000001'
const customer = '00000000-0000-4000-8000-000000000002'
const subsidiary = '00000000-0000-4000-8000-000000000003'
const dialect = new PgDialect()
const state = { missing: false, quotes: 0, queries: [] as ReturnType<PgDialect['sqlToQuery']>[] }
const legs = [
  { id: customer, func: 'USD', day: '2026-07-01', amount: '100' },
  { id: customer, func: 'USD', day: '2026-07-20', amount: '50' },
]
Object.assign(globalThis, { __customerReadExecute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
  const compiled = dialect.sqlToQuery(query)
  state.queries.push(compiled)
  const text = compiled.sql.replace(/\s+/g, ' ')
  if (text.includes('as time_zone')) return { rows: [{ time_zone: 'UTC' }] }
  if (text.includes('as "baseCurrency"')) return { rows: [{ baseCurrency: 'CAD' }] }
  if (text.includes('as cfg')) return { rows: [{ cfg: null, currency: null }] }
  if (text.includes('with needed as')) {
    state.quotes++
    return { rows: [
      { func: 'USD', as_of: '2026-07-20', rate: '2' },
      ...state.missing ? [] : [{ func: 'USD', as_of: '2026-07-01', rate: '1.2' }],
    ] }
  }
  if (text.includes('coalesce(p.display_name')) return { rows: legs.map((leg) => ({
    ...leg, name: 'Customer', revenue: leg.amount, txn_count: 1,
  })) }
  if (text.includes('as prior_recognized')) return { rows: legs.map((leg) => ({
    ...leg, recognized: leg.amount, prior_recognized: '0', credits: '0', tax: '0',
    inv_income: leg.amount, inv_nonar: leg.amount, sched: '0', voids: '0',
  })) }
  if (text.includes('as lifetime_revenue')) return { rows: legs.map((leg) => ({
    ...leg, lifetime_revenue: leg.amount, first_order: '2026-07-01', last_order: '2026-07-20',
  })) }
  if (text.includes('as credit_count')) return { rows: [{
    ...legs[1], credit_count: 1, credit_value: '10', order_count: 2,
  }] }
  if (text.includes('select to_char(movement.event_date')) return { rows: legs.map((leg) => ({
    ...leg, month: '2026-07', revenue: leg.amount,
  })) }
  if (text.includes('select to_char(e.posting_date')) return { rows: legs.map((leg) => ({
    ...leg, month: '2026-07', recognized: leg.amount,
  })) }
  if (text.includes('-sum(l.amount) as recognized')) return { rows: legs.map((leg) => ({
    ...leg, recognized: leg.amount,
  })) }
  return { rows: [] }
} })
const boundaries = new Map([
  [new URL('./query.ts', import.meta.url).href, `export async function analyticsQuery(query) { return globalThis.__customerReadExecute(query) }`],
  [new URL('../money-server.ts', import.meta.url).href, `
    import { createMoneyFormatter } from ${JSON.stringify(new URL('../money-format.ts', import.meta.url).href)};
    export async function getMoneyFormatter() { return createMoneyFormatter('en', 'CAD') }
  `],
])
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context)
    const boundary = boundaries.get(resolved.url)
    if (boundary !== undefined) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(boundary) }
    if (resolved.url.endsWith('/platform/db.ts')) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
      export * from ${JSON.stringify(new URL('../../../engine/src/platform/db.ts?native', import.meta.url).href)};
      export const db={execute:query=>globalThis.__customerReadExecute(query)};
    `) }
    return resolved
  },
})
const { customerData, customerSummaryData } = await import('./customer-data.ts')
const { MissingExchangeRateError } = await import('../fx-presentation.ts')
hooks.deregister()
const period = { from: '2026-07-01', to: '2026-07-31', label: 'July' }

test('customer read batches all flow sources and preserves dated exact revenue and cohort totals', async () => {
  state.quotes = 0
  state.queries.length = 0
  const data = await customerData(period, org, new Set([subsidiary]))
  assert.equal(state.quotes, 1)
  assert.equal(data.kpis.totalRevenue, '220.0000')
  assert.equal(data.kpis.totalInvoiced, '220.0000')
  assert.equal(data.rows[0]?.revenue, '220.0000')
  assert.equal(data.rows[0]?.recon.other, '0.0000')
  assert.equal(data.cohorts.list[0]?.totalRevenue, '220.0000')
  assert.equal(data.cohorts.list[0]?.totalInvoiced, '220.0000')
  assert.equal(data.growth.monthly[0]?.revenue, '220.0000')
  assert.equal(state.queries.some((query) => query.sql.includes('select to_char(e.posting_date')), false,
    'monthly recognition reuses the scoped customer ledger read')
  const movementQueries = state.queries.filter((query) => query.sql.includes('with movement as'))
  assert.ok(movementQueries.length > 1)
  assert.ok(movementQueries.every((query) => query.params.some((value) => JSON.stringify(value).includes(subsidiary))))
})

test('customer preview retains exact dated revenue without reading cohort history', async () => {
  state.quotes = 0
  state.queries.length = 0
  const data = await customerSummaryData(period, org, null)
  assert.equal(state.quotes, 1)
  assert.equal(data.kpis.totalRevenue, '220.0000')
  assert.equal(state.queries.some((query) => query.sql.includes('as lifetime_revenue')), false)
})

test('customer batch refuses missing early coverage even when a later rate exists', async () => {
  state.missing = true
  await assert.rejects(customerData(period, org, null), (error) =>
    error instanceof MissingExchangeRateError && error.date === '2026-07-01' && error.func === 'USD')
  state.missing = false
})
