import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test, { after } from 'node:test'

// E21: statement exports must stamp the actual generation instant, not
// business-day midnight. The data is resolved live inside the request, so the
// generation instant doubles as the data as-of: two exports of the same live
// ledger must order by when they ran.
const stateKey = Symbol.for('openbooks.statement-export-route-test')
const routeState = {
  captured: [] as Array<{ site: string; at: unknown }>,
  permissions: new Set(['reports.read']),
  resolved: [] as string[],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  ['mock:intl', `export * from '${import.meta.resolve('next-intl/server')}'
    export async function getTranslations() { return (key) => key }`],
  [
    'mock:report-book-label',
    `export function withReportBookColumn(data) { return data }`,
  ],
  [
    'mock:report-books',
    `export async function reportBookSelection() { return null }`,
  ],
  [
    'mock:authz',
    `export * from '${new URL('./authz.ts', import.meta.url).href}'
     import { can } from '${new URL('./authz.ts', import.meta.url).href}'
     import { NextResponse } from '${import.meta.resolve('next/server')}'
     const state = globalThis[Symbol.for('openbooks.statement-export-route-test')]
     export async function guardPermission(permission) {
       const authz = { user: { orgId: 'org-1', id: 'user-1' }, permissions: state.permissions, allowedSubsidiaryIds: null };
       return can(authz, permission) ? authz : NextResponse.json({ error: 'forbidden' }, { status: 403 });
     }`,
  ],
  [
    'mock:pdf-renderer',
    `export function rendererUnavailableResponse() { return null }`,
  ],
  [
    'mock:report-pdf',
    `
      const state = globalThis[Symbol.for('openbooks.statement-export-route-test')]
      function capture(site, opts) { state.captured.push({ site, at: opts?.generatedAt }) }
      export function exportDataToCsv() { return '' }
      export async function exportDataToPdf(data, branding, page, opts) { capture('exportDataToPdf', opts); return Buffer.from([]) }
      export async function exportDataToXlsx(data, opts) { capture('exportDataToXlsx', opts); return Buffer.from([]) }
      export async function orgBranding() { return {} }
      export async function renderStatementViewPdf(view, branding, page, opts) { capture('renderStatementViewPdf', opts); return Buffer.from([]) }
      export function resolveLayout() { return { page: {}, showSummary: true } }
      export function statementViewToExportData(view, opts) { return { title: opts.title, dateRangeLabel: opts.dateRangeLabel, groups: [], summary: [] } }
      export async function statementViewToXlsx(view, opts) { capture('statementViewToXlsx', opts); return Buffer.from([]) }
    `,
  ],
  [
    'mock:report-run',
    `
      export * from '${new URL('./report-run.ts', import.meta.url).href}'
      const state = globalThis[Symbol.for('openbooks.statement-export-route-test')]
      export async function resolveReport(kind) {
        state.resolved.push(kind)
        if (kind === 'balance-sheet') {
          return { render: 'view', view: { columns: [] }, title: 'Balance sheet', periodPhrase: 'FY26' }
        }
        if (kind !== 'pnl' && kind !== 'resourcing-capacity-demand') throw new Error('unexpected report fixture: ' + kind)
        return { render: 'data', data: { title: 'P&L', dateRangeLabel: 'FY26', groups: [], summary: [] } }
      }
    `,
  ],
  ['mock:periods', `export async function resolvePeriod() { return {} }`],
  [
    'mock:report-filters',
    `export function parseReportQuery() { return { period: 'this-fiscal-year', scale: 'actual' } }`,
  ],
  ['mock:report-labels', `export async function reportCsvOptions() { return {} }`],
  [
    'mock:export',
    `
      export function csvResponse() { return new Response('') }
      export function pdfResponse() { return new Response('') }
      export function safeName(value) { return value }
      export function xlsxResponse() { return new Response('') }
    `,
  ],
  ['mock:business-date', `export * from '${import.meta.resolve('@openbooks/engine/src/platform/business-date.ts')}'
    export async function businessToday() { return '2026-08-28' }`],
  ['mock:features', `export async function isFeatureEnabled() { return true }`],
  ['mock:projects-gate', `export async function guardProjectsFeature() { return null }`],
  [
    'mock:general-ledger-pdf',
    `export async function renderGeneralLedgerPaperPdf() { return Buffer.from([]) }`,
  ],
])

const mockUrls = new Map<string, string>([
  ['next-intl/server', 'mock:intl'],
  ['../../../../../../lib/report-book-label', 'mock:report-book-label'],
  ['../../../../../../lib/report-books', 'mock:report-books'],
  ['../../../../../../lib/authz', 'mock:authz'],
  ['@/lib/authz', 'mock:authz'],
  ['../../../../../../lib/api/pdf-renderer', 'mock:pdf-renderer'],
  ['../../../../../../lib/report-pdf', 'mock:report-pdf'],
  ['../../../../../../lib/report-run', 'mock:report-run'],
  ['../../../../../../lib/periods', 'mock:periods'],
  ['../../../../../../lib/report-filters', 'mock:report-filters'],
  ['../../../../../../lib/report-labels', 'mock:report-labels'],
  ['../../../../../../lib/export', 'mock:export'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
  ['../../../../../../lib/features', 'mock:features'],
  ['../../../../../../lib/projects-gate', 'mock:projects-gate'],
  ['../../../../../../lib/general-ledger-pdf', 'mock:general-ledger-pdf'],
])

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, _context)
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, _context)
  },
})

const routeUrl = '../app/api/reports/statement/[kind]/export/route.ts?statement-export-stamp-test'
const { GET } = (await import(routeUrl)) as typeof import(
  '../app/api/reports/statement/[kind]/export/route.ts'
)
after(() => hooks.deregister())

const BUSINESS_MIDNIGHT = Date.parse('2026-08-28T00:00:00Z')

function lastCapture(site: string): unknown {
  const found = routeState.captured.filter((c) => c.site === site).at(-1)
  assert.ok(found, `expected a ${site} call`)
  return found.at
}

async function capturedInstant(kind: string, format: string, site: string): Promise<number> {
  routeState.captured = []
  const before = Date.now()
  const response = await GET(
    new Request(`http://openbooks.test/api/reports/statement/${kind}/export?format=${format}`),
    { params: Promise.resolve({ kind }) },
  )
  const after = Date.now()
  assert.equal(response.status, 200)
  const at = lastCapture(site)
  assert.ok(at instanceof Date, `${site} must receive a Date stamp`)
  const ms = (at as Date).getTime()
  assert.ok(ms >= before && ms <= after, `stamp ${new Date(ms).toISOString()} must be the request instant`)
  return ms
}

test('data xlsx stamps the generation instant, not business-day midnight', async () => {
  const at = await capturedInstant('pnl', 'xlsx', 'exportDataToXlsx')
  assert.notEqual(at, BUSINESS_MIDNIGHT)
})

test('data pdf stamps the generation instant, not business-day midnight', async () => {
  const at = await capturedInstant('pnl', 'pdf', 'exportDataToPdf')
  assert.notEqual(at, BUSINESS_MIDNIGHT)
})

test('view pdf stamps the generation instant, not business-day midnight', async () => {
  const at = await capturedInstant('balance-sheet', 'pdf', 'renderStatementViewPdf')
  assert.notEqual(at, BUSINESS_MIDNIGHT)
})

test('view xlsx stamps the generation instant, not business-day midnight', async () => {
  const at = await capturedInstant('balance-sheet', 'xlsx', 'statementViewToXlsx')
  assert.notEqual(at, BUSINESS_MIDNIGHT)
})

test('resourcing export refuses missing permission before resolving report data', async () => {
  routeState.permissions = new Set(['reports.read'])
  routeState.resolved = []
  routeState.captured = []
  const response = await GET(new Request('http://openbooks.test/api/reports/statement/resourcing-capacity-demand/export?format=xlsx'), {
    params: Promise.resolve({ kind: 'resourcing-capacity-demand' }),
  })
  assert.equal(response.status, 403)
  assert.deepEqual(await response.json(), { error: 'you do not have access to this data' })
  assert.deepEqual(routeState.resolved, [])
  assert.deepEqual(routeState.captured, [])
})

test('resourcing export with explicit permission reaches the renderer', async () => {
  routeState.permissions = new Set(['reports.read', 'resourcing.read'])
  routeState.resolved = []
  try {
    await capturedInstant('resourcing-capacity-demand', 'xlsx', 'exportDataToXlsx')
    assert.deepEqual(routeState.resolved, ['resourcing-capacity-demand'])
  } finally {
    routeState.permissions = new Set(['reports.read'])
  }
})
