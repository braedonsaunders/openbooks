import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const root = pathToFileURL(process.cwd() + '/').href
const virtual = (source: string) => ({
  shortCircuit: true as const,
  url: `data:text/javascript,${encodeURIComponent(source)}`,
})

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'drizzle-orm' && context.parentURL?.startsWith('data:')) {
      return next(root + 'node_modules/drizzle-orm/index.js', context)
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      return virtual('export const db = globalThis.__customersPipelineDb')
    }
    if (specifier === '@openbooks/engine/src/platform/business-date.ts') {
      return virtual(`
        export function addCalendarDays(date, _days) { return date }
        export function calendarQuarterBounds(date) { return { start: date, end: date } }
        export function weekStartsEndingOn(_date, _weeks) { return ['2026-01-12'] }
        export async function businessToday(_orgId) { return '2026-01-15' }
      `)
    }
    if (specifier === '../crm' && context.parentURL?.endsWith('/web/lib/module-home/customers.ts')) {
      return virtual(`
        export async function calculateForecast() {
          return globalThis.__customersPipelineForecast
        }
      `)
    }
    if (specifier === '../crm-scope' && context.parentURL?.endsWith('/web/lib/module-home/customers.ts')) {
      return virtual("import { sql } from 'drizzle-orm'; export function crmOpportunityScope() { return sql`` }")
    }
    if (specifier === '../features' && context.parentURL?.endsWith('/web/lib/module-home/customers.ts')) {
      return virtual('export async function isFeatureEnabled() { return true }')
    }
    if (specifier === '../cash/core' && context.parentURL?.endsWith('/web/lib/module-home/customers.ts')) {
      // The DSO tile reads the cash engine; this pipeline-only contract stubs
      // the reader (the handoff itself is pinned in customers.test.ts).
      return virtual('export async function paymentStats() { return { map: new Map(), globalAvg: 45 } }')
    }
    if (specifier === '../cash/open-items' && context.parentURL?.endsWith('/web/lib/module-home/customers.ts')) {
      return virtual('export async function openItems(orgId, side, asOf, subIds) { globalThis.__customersPipelineOpenItemCalls.push({ orgId, side, asOf, subIds }); return [] }')
    }
    return next(specifier, context)
  },
})

const queryText = (query: unknown): string => {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? []
  return chunks.map((chunk) => {
    if (chunk && typeof chunk === 'object' && 'value' in chunk) {
      const value = (chunk as { value: unknown }).value
      return Array.isArray(value) ? value.join('') : String(value)
    }
    return ''
  }).join('')
}

const executedQueryTexts: string[] = []
const openItemCalls: { orgId: string; side: string; asOf: string; subIds: string[] | undefined }[] = []
Object.assign(globalThis, {
  __customersPipelineForecast: [
    { currency: 'CAD', pipeline_amount: '100.0000', weighted_amount: '50.0000', closed_amount: '20.0000' },
    { currency: 'USD', pipeline_amount: '100.0000', weighted_amount: '50.0000', closed_amount: '20.0000' },
  ],
  __customersPipelineExecutedQueries: executedQueryTexts,
  __customersPipelineOpenItemCalls: openItemCalls,
  __customersPipelineDb: {
    execute: async (query: unknown) => {
      const text = queryText(query)
      executedQueryTexts.push(text)
      if (text.includes('base_currency')) return { rows: [{ baseCurrency: 'CAD' }] }
      if (text.includes('from fx_rates')) return { rows: [{ rate: '1.3500000000' }] }
      return { rows: [] }
    },
  },
})

const { customersHome } = await import('./customers')

test('customer pipeline converts each forecast currency before org-currency formatting', async () => {
  const home = await customersHome('org-1')
  assert.deepEqual(home.pipeline, { total: '235.0000', weighted: '117.5000', closed: '47.0000' })
})

test('customer pipeline sums large decimal strings without a floating-point round trip', async (t) => {
  const state = globalThis as typeof globalThis & { __customersPipelineForecast: unknown[] }
  const previous = state.__customersPipelineForecast
  state.__customersPipelineForecast = [
    { currency: 'CAD', pipeline_amount: '12345678901234.1255', weighted_amount: '0.1255', closed_amount: '1.0001' },
    { currency: 'CAD', pipeline_amount: '0.0001', weighted_amount: '0.0001', closed_amount: '0.0001' },
  ]
  t.after(() => { state.__customersPipelineForecast = previous })

  const home = await customersHome('org-1')
  assert.deepEqual(home.pipeline, {
    total: '12345678901234.1256',
    weighted: '0.1256',
    closed: '1.0002',
  })
})

test('customer receivables delegate their date and scope to the cash open-item reader', async () => {
  openItemCalls.length = 0
  await customersHome('org-1')
  assert.deepEqual(openItemCalls, [{ orgId: 'org-1', side: 'ar', asOf: '2026-01-15', subIds: undefined }])
})
