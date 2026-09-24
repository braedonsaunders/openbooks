import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// A bare aging export URL (no as-of, no period) once fell through to the
// fiscal year end, so every balance landed in 90+ (F-t07-011). The export
// must resolve bare hits through the shared aging as-of rule (screen
// default: today), while explicit params keep their meaning.
const TODAY = '2026-09-24'
const agingKey = Symbol.for('openbooks.aging-export-asof-test')
const agingState: {
  asOfValues: unknown[]
  bookThreading: Array<{ kind: string; bookId: unknown }>
  featuresOn: string[]
} = {
  asOfValues: [],
  bookThreading: [],
  featuresOn: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[agingKey] = agingState

const reportsIndexUrl = new URL('./reports.ts', import.meta.url).href
const reportPdfUrl = new URL('./report-pdf.ts', import.meta.url).href
const dbUrl = import.meta.resolve('@openbooks/engine/src/platform/db.ts')
const consolidationUrl = new URL('./consolidation.ts', import.meta.url).href
const executionContextUrl = new URL('./report-execution-context.ts', import.meta.url).href

const mockSources = new Map<string, string>([
  [
    'mock:features',
    `const state = globalThis[Symbol.for('openbooks.aging-export-asof-test')]
     export async function isFeatureEnabled(orgId, key) { return state.featuresOn.includes(key) }
     export async function subsidiaryFeatureEnabled() { return false }`,
  ],
  [
    'mock:execution-context',
    `
      export * from '${executionContextUrl}'
      export async function requireReportAuthz(orgId) {
        return { user: { orgId, id: 'user-1' }, permissions: new Set(), allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    'mock:consolidation',
    `export * from '${consolidationUrl}'
     export async function resolveSubsidiaryView() { return {} }`,
  ],
  [
    'mock:periods',
    `
      export async function resolvePeriod(preset, opts) {
        if (preset === 'today') return { from: '${TODAY}', to: '${TODAY}', label: '' }
        throw new Error('unexpected period preset: ' + preset)
      }
    `,
  ],
  [
    'mock:reports',
    `
      export * from '${reportsIndexUrl}'
      const state = globalThis[Symbol.for('openbooks.aging-export-asof-test')]
      export async function agingByParty(side, asOf, dims, orgId, opts) {
        state.asOfValues.push(asOf)
        state.bookThreading.push({ kind: 'aging', bookId: opts?.bookId })
        return []
      }
      const thread = (kind, bookId) => { state.bookThreading.push({ kind, bookId }) }
      // Shape contract with web/lib/report-run.ts: the ledger resolves to
      // { accounts } and the journal to { entries }; the export-data mocks
      // ignore the payloads, but resolveReport reads these fields.
      export async function generalLedger(from, to, opts) { thread('general-ledger', opts?.bookId); return { accounts: [] } }
      export async function journalReport(from, to, opts) { thread('journal', opts?.bookId); return { entries: [] } }
      export async function partyRegister(side, opts) { thread('registers', opts?.bookId); return [] }
      export async function partnerStatement(partyId, orgId, opts) { thread('partner-statement', opts?.bookId); return {} }
      export async function projectProfitability(from, to, opts) { thread('project-profitability', opts?.bookId); return [] }
      export async function trialBalance(asOf, dims, orgId, bookId) { thread('trial-balance', bookId); return [] }
      export async function partnerBalances(s, orgId, asOf, bookId, dims) { thread('partners', bookId); return [] }
      export async function cashFlow(from, to, dims, orgId, bookId) { thread('cash-flow', bookId); return {} }
      export async function cashFlowIndirect(from, to, dims, orgId, bookId) { thread('cash-flow-indirect', bookId); return {} }
    `,
  ],
  [
    'mock:report-pdf',
    `export * from '${reportPdfUrl}'
     export function agingExportData() { return { title: 'Aging', dateRangeLabel: '', summary: [], groups: [] } }
     export function generalLedgerExportData() { return { title: 'GL' } }
     export function journalExportData() { return { title: 'Journal' } }
     export function registerExportData() { return { title: 'Register' } }
     export function partnerStatementExportData() { return { title: 'Statement' } }
     export function projectProfitabilityExportData() { return { title: 'Projects' } }
     export function trialBalanceExportData() { return { title: 'TB' } }
     export function partnersExportData() { return { title: 'Partners' } }
     export function cashFlowExportData() { return { title: 'CF' } }
     export function cashFlowIndirectExportData() { return { title: 'CFI' } }`,
  ],
  [
    'mock:db',
    `export * from '${dbUrl}'
     export const db = { async execute(query) {
       const chunks = query?.queryChunks ?? [];
       const text = chunks.map((c) => typeof c === 'string' ? c : (Array.isArray(c?.value) ? c.value.join('') : '')).join(' ').slice(0, 200);
       if (text.includes('from accounting_books')) {
         return { rows: [
           { id: '11111111-1111-1111-8111-111111111111', code: 'PRIMARY', name: 'Primary book', is_primary: true },
           { id: '22222222-2222-2222-8222-222222222222', code: 'TAX', name: 'Tax book', is_primary: false },
         ] };
       }
       throw new Error("unexpected SQL before the reader: " + text);
     } }`,
  ],
])

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`
const mockUrls = new Map<string, string>([
  ['./features', mockUrl('features')],
  ['./report-execution-context', mockUrl('execution-context')],
  ['./consolidation', mockUrl('consolidation')],
  ['./periods', mockUrl('periods')],
  ['./reports', mockUrl('reports')],
  ['./report-pdf', mockUrl('report-pdf')],
  ['@openbooks/engine/src/platform/db.ts', mockUrl('db')],
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
    const parsed = new URL(url)
    const name = parsed.searchParams.get('mock')
    const source = name ? mockSources.get(`mock:${name}`) : undefined
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const runUrl = './report-run.ts?aging-export-asof'
const { resolveReport } = (await import(runUrl)) as typeof import('./report-run.ts')
const { parseReportQuery } = (await import('./report-filters.ts')) as typeof import('./report-filters.ts')
hooks.deregister()

const ctx = {
  orgId: 'org-1',
  t: ((key: string) => key) as (key: string) => string,
  period: { from: '2026-01-01', to: '2026-12-31', label: '' },
  query: parseReportQuery(new URLSearchParams()),
}

test('a bare aging export resolves its as-of to today, not the fiscal year end', async () => {
  agingState.asOfValues = []

  await resolveReport('aging', new URLSearchParams(), ctx)

  assert.deepEqual(agingState.asOfValues, [TODAY])
})

test('an explicit aging as-of keeps its meaning', async () => {
  agingState.asOfValues = []

  await resolveReport('aging', new URLSearchParams('asOf=2026-07-31'), ctx)

  assert.deepEqual(agingState.asOfValues, ['2026-07-31'])
})

// A secondary-book statement export must not silently mix primary-book
// detail lines: every journal-backed detail reader receives the selected
// book, while a bare export keeps the readers' primary-book default.
test('statement exports thread the selected book into every journal-backed detail reader', async () => {
  const SECONDARY = '22222222-2222-2222-8222-222222222222'
  const PARTY = '33333333-3333-3333-8333-333333333333'
  const cases: Array<[Parameters<typeof resolveReport>[0], Record<string, string>]> = [
    ['general-ledger', {}],
    ['journal', {}],
    ['registers', {}],
    ['partner-statement', { party: PARTY }],
    ['project-profitability', {}],
    ['trial-balance', {}],
    ['partners', {}],
    ['aging', {}],
    ['cash-flow', {}],
    ['cash-flow-indirect', {}],
  ]
  agingState.featuresOn = ['projects']
  try {
    for (const [kind, extra] of cases) {
      agingState.bookThreading = []
      await resolveReport(kind, new URLSearchParams({ book: SECONDARY, ...extra }), ctx)
      assert.deepEqual(agingState.bookThreading, [{ kind, bookId: SECONDARY }])
    }
  } finally {
    agingState.featuresOn = []
  }

  agingState.bookThreading = []
  await resolveReport('general-ledger', new URLSearchParams(), ctx)
  assert.deepEqual(agingState.bookThreading, [{ kind: 'general-ledger', bookId: undefined }])
})
