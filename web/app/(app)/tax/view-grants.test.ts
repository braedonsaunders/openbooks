import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// C-70: the tax page gated Save snapshot and mark-filed on reports.create
// while the save/file routes demand compliance.file — so a reports.create
// holder saw actions that 403, and a compliance.file holder never saw them.
// Both flags now derive from the route's own permission constant (a single
// symbol, no duplicated literal). Loader-proved with each grant.

const stateKey = Symbol.for('openbooks.tax-view-grants-test')
interface ViewState {
  grants: Set<string>
}
const viewState: ViewState = { grants: new Set() }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = viewState

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      if (typeof c === 'string') return c
      const value = (c as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((c as { queryChunks?: unknown[] })?.queryChunks) return sqlText(c)
      return ''
    })
    .join('')
}

const FILING_ROW = {
  id: 'f1',
  form_name: 'GST/HST Return',
  form_code: 'CA_GST34',
  country: 'CA',
  period_from: '2026-01-01',
  period_to: '2026-03-31',
  version: 1,
  status: 'prepared',
  filing_reference: null,
  filed_at: null,
  snapshot_hash: 'hash-1',
  boxes: [],
  created_at: '2026-04-01T00:00:00Z',
}

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.tax-view-grants-test')]
      export async function requirePermission(permission) {
        if (!state.grants.has(permission)) throw new Error('forbidden: ' + permission)
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null, permissions: state.grants }
      }
      export function can(authz, permission) {
        return state.grants.has(permission)
      }
      export async function guardPermission(permission) {
        if (!state.grants.has(permission)) throw new Error('forbidden: ' + permission)
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null, permissions: state.grants }
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  [
    'mock:intl',
    `export async function getTranslations() { return (key) => key }`,
  ],
  [
    'mock:navigation',
    `export function notFound() { throw new Error('notFound') }`,
  ],
  [
    'mock:viewspec',
    `
      export function page(spec) { return spec }
      export function ref() { return () => false }
      export function widgetBlock(kind, props) { return { kind, ...props } }
    `,
  ],
  [
    'mock:db',
    `
      export const db = {
        async execute(query) {
          const text = (${sqlText.toString()})(query)
          if (text.includes('where id')) return { rows: [${JSON.stringify(FILING_ROW)}] }
          if (text.includes('count(*)')) return { rows: [{ count: 0 }] }
          return { rows: [] }
        },
      }
    `,
  ],
  [
    'mock:tax-return',
    `export async function computeTaxReturn() { throw new Error('unexpected compute') }`,
  ],
  [
    'mock:tax-filing',
    `
      export const TAX_FILING_SNAPSHOT_VERSION = 2
      export function buildTaxFilingSnapshot() { throw new Error('unexpected snapshot') }
    `,
  ],
  [
    'mock:tax-nexus-ledger',
    `export async function loadOrgFilingCalendar() { return [] }`,
  ],
  [
    'mock:business-date',
    `export async function businessToday() { return '2026-08-24' }`,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../lib/authz', 'mock:authz'],
  ['../../../../lib/authz', 'mock:authz'],
  ['next-intl/server', 'mock:intl'],
  ['next/navigation', 'mock:navigation'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@openbooks/engine/src/tax-returns/return.ts', 'mock:tax-return'],
  ['@openbooks/engine/src/tax-returns/filing.ts', 'mock:tax-filing'],
  ['@openbooks/engine/src/tax/nexus-ledger.ts', 'mock:tax-nexus-ledger'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
  ['@braedonsaunders/appkit-viewspec', 'mock:viewspec'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
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

const viewUrl = './view.ts?tax-view-grants-test'
const { loadTax } = (await import(viewUrl)) as typeof import('./view.ts')
const routeUrl = '../../api/tax/filings/route.ts?tax-view-grants-test'
const { TAX_FILING_WRITE_PERMISSION } = (await import(routeUrl)) as typeof import('../../api/tax/filings/route')
hooks.deregister()

function reset(grants: string[]): void {
  viewState.grants = new Set(grants)
}

test('the page and the route share one filing-write permission', async () => {
  assert.equal(TAX_FILING_WRITE_PERMISSION, 'compliance.file')
})

test('a reports.create holder sees no save or file action', async () => {
  reset(['reports.read', 'reports.create'])

  const data = await loadTax({})

  assert.equal(data.canSave, false)
})

test('a compliance.file holder sees the save action', async () => {
  reset(['reports.read', 'compliance.file'])

  const data = await loadTax({})

  assert.equal(data.canSave, true)
})

test('mark-filed follows the filing grant on the history drawer', async () => {
  reset(['reports.read', 'reports.create'])
  const denied = await loadTax({ filing: '11111111-1111-4111-8111-111111111111' })
  assert.equal(denied.drawer?.canFile, false)

  reset(['reports.read', 'compliance.file'])
  const allowed = await loadTax({ filing: '11111111-1111-4111-8111-111111111111' })
  assert.equal(allowed.drawer?.canFile, true)
})
