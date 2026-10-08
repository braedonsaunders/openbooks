import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, test } from 'node:test'

const state = { currencies: new Map<string, string>(), calls: [] as string[], dialect: new PgDialect() }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[Symbol.for('openbooks.presentation-read-test')] = state
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === './analytics/query' && context.parentURL?.endsWith('/web/lib/fx-presentation.ts')) {
      return { shortCircuit: true, url: 'mock:presentation-read-query' }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'mock:presentation-read-query') return { shortCircuit: true, format: 'module', source: `
      const state = globalThis[Symbol.for('openbooks.presentation-read-test')];
      export async function analyticsQuery(query) {
        const compiled = state.dialect.sqlToQuery(query);
        if (!compiled.sql.includes('select base_currency')) throw Error('Unexpected financial query');
        const orgId = compiled.params[0]; state.calls.push(orgId);
        const baseCurrency = state.currencies.get(orgId);
        return {rows: baseCurrency ? [{baseCurrency}] : []};
      }
    ` }
    return next(url, context)
  },
})
const { presentationCurrency, withPresentationCurrencyRead, flowRates } = await import('./fx-presentation')
hooks.deregister()
beforeEach(() => { state.currencies = new Map([['org-a', 'CAD'], ['org-b', 'USD']]); state.calls = [] })

test('one composed financial read shares a demanded native currency across concurrent widgets', async () => {
  await withPresentationCurrencyRead(async () => {
    const values = await Promise.all(Array.from({length: 6}, () => presentationCurrency('org-a')))
    assert.deepEqual(values, Array(6).fill('CAD'))
    const flows = await flowRates('org-a', [{func: null, date: '2026-10-08'}])
    assert.equal(flows.base, 'CAD'); assert.equal(flows.rateAt(null, '2026-10-08'), '1')
  })
  assert.deepEqual(state.calls, ['org-a'])
})

test('tenant currencies remain distinct and new composed and direct reads resolve current facts', async () => {
  assert.deepEqual(await withPresentationCurrencyRead(() => Promise.all([
    presentationCurrency('org-a'), presentationCurrency('org-b'), presentationCurrency('org-a'),
  ])), ['CAD', 'USD', 'CAD'])
  assert.deepEqual(state.calls, ['org-a', 'org-b'])
  state.currencies.set('org-a', 'EUR')
  assert.equal(await withPresentationCurrencyRead(() => presentationCurrency('org-a')), 'EUR')
  assert.equal(await presentationCurrency('org-a'), 'EUR')
  assert.equal(await presentationCurrency('org-a'), 'EUR')
  assert.deepEqual(state.calls, ['org-a', 'org-b', 'org-a', 'org-a', 'org-a'])
})

test('empty reads demand no currency and missing configuration refuses every dependent widget', async () => {
  await withPresentationCurrencyRead(async () => { assert.equal((await flowRates('missing', [])).base, '') })
  assert.deepEqual(state.calls, [])
  const results = await withPresentationCurrencyRead(() => Promise.allSettled([
    presentationCurrency('missing'), presentationCurrency('missing'),
  ]))
  assert.deepEqual(state.calls, ['missing'])
  for (const result of results) {
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.match(result.reason.message, /has no base currency/)
  }
  state.currencies.set('missing', 'CAD')
  assert.equal(await withPresentationCurrencyRead(() => presentationCurrency('missing')), 'CAD')
})
