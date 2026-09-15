import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import test from 'node:test'

// Exercise the actual dashboard query builder, as accounting.test.ts does,
// and inspect the SQL and bound values that reach the database boundary.
const queries: SQL[] = []
const stateKey = Symbol.for('openbooks.customers-home-scope-test')
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = queries
const mocks = new Map([
  ['server-only', 'export {}'],
  ['@openbooks/engine/src/db.ts', `
    export const db = { execute: async (query) => {
      globalThis[Symbol.for('openbooks.customers-home-scope-test')].push(query)
      // One canned row satisfies the org-currency lookup every dashboard
      // call ends with; the inspected DSO row carries no dso, so dsoLite
      // stays null exactly like an empty payment history.
      return { rows: [{ baseCurrency: 'CAD' }] }
    } }
  `],
  ['@openbooks/engine/src/business-date.ts', `
    export async function businessToday() { return '2026-08-28' }
    export function addCalendarDays(date, days) { return days === -365 ? '2025-08-28' : '2026-08-21' }
    export function weekStartsEndingOn() { return ['2026-08-24'] }
    export function calendarQuarterBounds() { return { start: '2026-07-01', end: '2026-09-30' } }
  `],
  ['../features', 'export async function isFeatureEnabled() { return false }'],
  ['../crm', 'export async function calculateForecast() { return [] }'],
  ['../crm-scope', "export function crmOpportunityScope() { throw new Error('CRM is disabled') }"],
])
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mock = mocks.get(specifier)
    if (mock !== undefined) return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(mock)}` }
    return nextResolve(specifier, context)
  },
})
const customersUrl = './customers.ts?scope-contract'
const { customersHome } = await import(customersUrl) as typeof import('./customers.ts')
hooks.deregister()

const subsidiaryA = '00000000-0000-0000-0000-000000000001'
const subsidiaryB = '00000000-0000-0000-0000-000000000002'
const dialect = new PgDialect()

async function dsoQuery(subIds?: string[]) {
  queries.length = 0
  const home = await customersHome('00000000-0000-0000-0000-000000000003', subIds)
  assert.equal(home.dsoLite, null, 'no payment history has no DSO')
  const query = queries.map((query) => dialect.sqlToQuery(query))
    .find((query) => query.sql.includes('as dso'))
  assert.ok(query, 'dashboard executes its DSO query')
  return query
}

for (const [name, ids] of [
  ['one subsidiary', [subsidiaryA]],
  ['multiple subsidiaries', [subsidiaryA, subsidiaryB]],
  ['empty scope', []],
] as const) {
  test(`customer DSO filters the invoice subsidiary for ${name}`, async () => {
    const query = await dsoQuery([...ids])
    const predicate = query.sql.match(/bl\.subsidiary_id = any\(\$(\d+)::uuid\[\]\)/)
    assert.ok(predicate, 'DSO must filter the invoice line by allowed subsidiaries')
    assert.equal(query.params[Number(predicate[1]) - 1], `{${ids.join(',')}}`)
  })
}

test('unrestricted customer DSO includes all subsidiaries', async () => {
  const query = await dsoQuery()
  assert.doesNotMatch(query.sql, /subsidiary_id/)
})

test('customer receipt totals convert every transaction amount before aggregation', () => {
  // Defined after the async dashboard tests: a sync test registered before
  // the top-level dashboard import leaves the later async tests cancelled
  // under --test-force-exit.
  const source = readFileSync(join(import.meta.dirname, 'customers.ts'), 'utf8')
  // The trend and 7-day badge each need the per-document conversion. Summing
  // transaction totals directly would make (for example) CAD 100 + JPY 10,000
  // appear as one 10,100-unit amount in the organization currency.
  const conversions = source.match(/sum\(round\(abs\(d\.total \* d\.fx_rate\), 4\)\)/g) ?? []
  assert.equal(conversions.length, 2)
  assert.doesNotMatch(source, /sum\(abs\(d\.total\)\)/)
})
