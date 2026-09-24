import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// A bare aging export URL (no as-of, no period) once fell through to the
// fiscal year end, so every balance landed in 90+ (F-t07-011). The export
// must resolve bare hits through the shared aging as-of rule (screen
// default: today), while explicit params keep their meaning.
const TODAY = '2026-09-24'
const agingKey = Symbol.for('openbooks.aging-export-asof-test')
const agingState: { asOfValues: unknown[] } = { asOfValues: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[agingKey] = agingState

const reportsIndexUrl = new URL('./reports.ts', import.meta.url).href
const reportPdfUrl = new URL('./report-pdf.ts', import.meta.url).href
const dbUrl = import.meta.resolve('@openbooks/engine/src/platform/db.ts')
const consolidationUrl = new URL('./consolidation.ts', import.meta.url).href
const executionContextUrl = new URL('./report-execution-context.ts', import.meta.url).href

const mockSources = new Map<string, string>([
  [
    'mock:features',
    'export async function isFeatureEnabled() { return false }; export async function subsidiaryFeatureEnabled() { return false }',
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
      export async function agingByParty(side, asOf) {
        state.asOfValues.push(asOf)
        return []
      }
    `,
  ],
  [
    'mock:report-pdf',
    `export * from '${reportPdfUrl}'
     export function agingExportData() { return { title: 'Aging', dateRangeLabel: '', summary: [], groups: [] } }`,
  ],
  [
    'mock:db',
    `export * from '${dbUrl}'
     export const db = { async execute(query) {
       const chunks = query?.queryChunks ?? [];
       const text = chunks.map((c) => typeof c === 'string' ? c : '').join(' ').slice(0, 100);
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
