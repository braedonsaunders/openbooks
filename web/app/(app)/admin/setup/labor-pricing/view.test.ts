import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'

const org = '00000000-0000-4000-8000-000000000001'
const card = '00000000-0000-4000-8000-000000000002'
const dialect = new PgDialect()
const state = { projects: true, queries: [] as string[], missing: false }
Object.assign(globalThis, { __laborPricingBoundary: state })
Object.assign(globalThis, { __laborPricingExecute: async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
  const compiled = dialect.sqlToQuery(query)
  const text = compiled.sql.replace(/\s+/g, ' ')
  state.queries.push(text)
  if (text.includes('as time_zone')) return { rows: [{ time_zone: 'UTC' }] }
  if (text.includes("settings->'features'")) return { rows: [{ f: {
    projects: state.projects, multiSubsidiary: true, multiCurrency: true,
  } }] }
  if (text.includes('count(*)::int n')) return { rows: [{ n: 1 }] }
  if (text.includes('where v.id=')) return { rows: state.missing ? [] : [{
    id: card, rate_book_id: card, name: 'Consulting', code: 'CONSULT', currency: 'CAD',
    status: 'draft', scopes: [], adjustments: [], terms: [], lines: [], custom: {},
  }] }
  if (text.includes('as assignment_count')) return { rows: [{ id: card, name: 'Consulting' }] }
  if (text.includes('base_currency as currency from subsidiaries')) return { rows: [{ id: org, name: 'Company', currency: 'CAD' }] }
  if (text.includes("settings->'currencies'")) return { rows: [{ base_currency: 'CAD', currencies: ['USD'] }] }
  if (text.includes('from items') && text.includes('id,name,kind,category')) return { rows: [{ id: card, name: 'Hours', kind: 'service', category: null }] }
  if (text.includes('from time_types')) return { rows: [{ id: card, name: 'Regular', bill_multiplier: '1' }] }
  if (text.includes('from departments')) return { rows: [{ id: org, name: 'Operations' }] }
  return { rows: [] }
} })
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next-intl/server') return {
      shortCircuit: true, url: 'data:text/javascript,export async function getTranslations(){return(key)=>key}',
    }
    if (specifier === '../../../../../lib/authz') return {
      shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
        export async function requirePermission(key) {
          if (key !== 'admin.setup.manage') throw new Error('Unexpected permission');
          return { user: { orgId: ${JSON.stringify(org)}, id: ${JSON.stringify(card)}, roles: [{key:'admin'}] }, permissions: new Set(['admin.setup.manage']) };
        }
        export function can(authz, key) { return authz.permissions.has(key); }
      `),
    }
    const resolved = next(specifier, context)
    if (resolved.url.endsWith('/platform/db.ts')) return {
      shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
        export * from ${JSON.stringify(new URL('../../../../../../engine/src/platform/db.ts?native', import.meta.url).href)};
        export const db={execute:query=>globalThis.__laborPricingExecute(query)};
      `),
    }
    return resolved
  },
})
const { loadLaborPricing } = await import('./view.ts')
hooks.deregister()

test('closed labor pricing lists omit editing pickers while retaining New and scope-filter facts', async () => {
  state.queries.length = 0
  const data = await loadLaborPricing({})
  assert.ok(data)
  assert.equal(data.view.selected, null)
  assert.deepEqual(data.view.items, [])
  assert.deepEqual(data.view.timeTypes, [])
  assert.deepEqual(data.view.options.department, [])
  assert.deepEqual(data.view.options.subsidiary, [{ id: org, name: 'Company', currency: 'CAD' }])
  assert.deepEqual(data.view.currencies, ['CAD', 'USD'])
  assert.equal(data.view.total, 1)
  assert.equal(state.queries.some((sql) => /from (items|time_types|departments|projects|documents|custom_field_defs)\b/.test(sql)), false)
})

test('selected labor cards retain native editing pickers and default form resolution', async () => {
  state.queries.length = 0
  const data = await loadLaborPricing({ card })
  assert.ok(data)
  assert.equal(data.view.selected?.id, card)
  assert.equal(data.view.items[0]?.name, 'Hours')
  assert.equal(data.view.timeTypes[0]?.name, 'Regular')
  assert.equal(data.view.options.department?.[0]?.name, 'Operations')
  assert.ok(data.view.layout)
  assert.ok(state.queries.some((sql) => sql.includes('from custom_field_defs')))
  assert.ok(state.queries.some((sql) => sql.includes('from form_layouts')))
})

test('disabled Projects refuses before any labor rate or picker data is read', async () => {
  state.projects = false
  state.queries.length = 0
  await assert.rejects(loadLaborPricing({ card }), (error) =>
    error instanceof Error && 'digest' in error && String(error.digest).includes('/feature-required?feature=projects'))
  assert.equal(state.queries.some((sql) => /from (item_rate_versions|items|departments)\b/.test(sql)), false)
  state.projects = true
})
