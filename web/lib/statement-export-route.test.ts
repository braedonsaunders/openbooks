import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// E21: statement exports must stamp the actual generation instant, not
// business-day midnight. The data is resolved live inside the request, so the
// generation instant doubles as the data as-of: two exports of the same live
// ledger must order by when they ran.
const stateKey = Symbol.for('openbooks.statement-export-route-test')
const routeState = { captured: [] as Array<{ site: string; at: unknown }> }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

const mockSources = new Map<string, string>([
  ['mock:intl', `export async function getTranslations() { return (key) => key }`],
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
    `export async function guardPermission() { return { user: { orgId: 'org-1', id: 'user-1' } } }`,
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
      export function isReportKind(kind) { return kind === 'pnl' || kind === 'balance-sheet' }
      export async function resolveReport(kind) {
        if (kind === 'balance-sheet') {
          return { render: 'view', view: { columns: [] }, title: 'Balance sheet', periodPhrase: 'FY26' }
        }
        return { render: 'data', data: { title: 'P&L', dateRangeLabel: 'FY26', groups: [], summary: [] } }
      }
    `,
  ],
  ['mock:pdf', `export function resolvePdfPageSetup() { return {} }`],
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
  ['mock:business-date', `export async function businessToday() { return '2026-08-28' }`],
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
  ['../../../../../../lib/api/pdf-renderer', 'mock:pdf-renderer'],
  ['../../../../../../lib/report-pdf', 'mock:report-pdf'],
  ['../../../../../../lib/report-run', 'mock:report-run'],
  ['@openbooks/pdf', 'mock:pdf'],
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
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
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
hooks.deregister()

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
