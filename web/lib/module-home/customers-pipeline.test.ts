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
    if (specifier === 'server-only') return virtual('export {}')
    if (specifier === 'drizzle-orm' && context.parentURL?.startsWith('data:')) {
      return next(root + 'node_modules/drizzle-orm/index.js', context)
    }
    if (specifier === '@openbooks/engine/src/db.ts') {
      return virtual('export const db = globalThis.__customersPipelineDb')
    }
    if (specifier === '@openbooks/engine/src/business-date.ts') {
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
    if (specifier.startsWith('@/')) return next(root + 'web/' + specifier.slice(2) + '.ts', context)
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

Object.assign(globalThis, {
  __customersPipelineForecast: [
    { currency: 'CAD', pipeline_amount: '100.0000', weighted_amount: '50.0000', closed_amount: '20.0000' },
    { currency: 'USD', pipeline_amount: '100.0000', weighted_amount: '50.0000', closed_amount: '20.0000' },
  ],
  __customersPipelineDb: {
    execute: async (query: unknown) => {
      const text = queryText(query)
      if (text.includes('base_currency')) return { rows: [{ baseCurrency: 'CAD' }] }
      if (text.includes('from fx_rates')) return { rows: [{ rate: '1.3500000000' }] }
      return { rows: [] }
    },
  },
})

const { customersHome } = await import('./customers')

test('customer pipeline converts each forecast currency before org-currency formatting', async () => {
  const home = await customersHome('org-1')
  assert.deepEqual(home.pipeline, { total: 235, weighted: 117.5, closed: 47 })
})
