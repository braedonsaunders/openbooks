import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NextResponse } from 'next/server'

// Route boundary suite for the frozen-filing export (D2): the reprint must
// denominate the frozen boxes in the filing's FROZEN currency and carry its
// frozen identity — never the org's live base currency — and must refuse
// (with the remedy) a pre-snapshot filing whose currency was never frozen.

interface ExportState {
  filingRow: Record<string, unknown> | null
  captured: Record<string, unknown> | null
}

const stateKey = Symbol.for('openbooks.filing-export-route-test')
const exportState: ExportState = { filingRow: null, captured: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = exportState
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksFilingExportNextResponse =
  NextResponse

/** Flatten a drizzle SQL chunk into its raw text for query scripting. */
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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksSqlTextFilingExport = sqlText

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.filing-export-route-test')]
      const NextResponse = globalThis.openbooksFilingExportNextResponse
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  ['mock:list-params', `export function isUuid() { return true }`],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.filing-export-route-test')]
      const sqlText = globalThis.openbooksSqlTextFilingExport
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          // The old defect read the org's CURRENT base through a subquery.
          // Emulate that store: any query touching orgs answers the live base
          // (USD), while the filing read answers the frozen row. A route that
          // still relabels from orgs therefore reprints USD, never the frozen
          // EUR — and a route that selects the frozen columns gets them.
          if (text.includes('select base_currency from orgs')) return { rows: [{ base_currency: 'USD' }] }
          if (text.includes('from tax_filings')) return { rows: state.filingRow ? [state.filingRow] : [] }
          throw new Error('unexpected database query: ' + text.slice(0, 120))
        },
      }
    `,
  ],
  [
    'mock:business-date',
    `export async function businessToday() { return '2026-08-24' }`,
  ],
  [
    'mock:intl',
    `export async function getTranslations() { return (key) => key }`,
  ],
  [
    'mock:export-lib',
    `
      const NextResponse = globalThis.openbooksFilingExportNextResponse
      export function safeName(name) { return name }
      export function csvResponse(body, filename) { return new Response('CSV ' + filename + '\\n' + body) }
      export function pdfResponse() { throw new Error('unexpected pdf render') }
      export function xlsxResponse() { throw new Error('unexpected xlsx render') }
    `,
  ],
  [
    'mock:tax-filing',
    `
      const state = globalThis[Symbol.for('openbooks.filing-export-route-test')]
      export function taxReturnExportData(result) {
        state.captured = result
        return { title: 'T', dateRangeLabel: '', summary: [], groups: [] }
      }
    `,
  ],
  [
    'mock:report-pdf',
    `
      export function exportDataToCsv() { return 'csv-bytes' }
      export async function exportDataToXlsx() { throw new Error('unexpected xlsx render') }
      export async function orgBranding() { throw new Error('unexpected branding read') }
      export function resolveLayout() { throw new Error('unexpected layout') }
      export async function exportDataToPdf() { throw new Error('unexpected pdf render') }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../../../lib/authz', 'mock:authz'],
  ['../../../../../../lib/list-params', 'mock:list-params'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
  ['next-intl/server', 'mock:intl'],
  ['../../../../../../lib/export', 'mock:export-lib'],
  ['../../../../../../lib/tax-filing', 'mock:tax-filing'],
  ['../../../../../../lib/report-pdf', 'mock:report-pdf'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
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

const exportRouteUrl = './route.ts?filing-export-frozen-test'
const { GET } = (await import(exportRouteUrl)) as typeof import('./route.ts')
hooks.deregister()

const SUB = '11111111-1111-4111-8111-111111111111'

function frozenRow(): Record<string, unknown> {
  return {
    form_code: 'VAT100',
    form_name: 'VAT100',
    period_from: '2026-01-01',
    period_to: '2026-03-31',
    submission_channel: 'portal_manual',
    boxes: [{ lineCode: '1', label: 'Box 1', value: '100.0000', computed: true, editable: false }],
    snapshot_hash: 'hash-1',
    version: 3,
    functional_currency: 'EUR',
    translation: {
      presentationCurrency: 'EUR',
      rateType: 'spot',
      rateDate: '2026-03-31',
      entities: [],
    },
    subsidiary_ids: [SUB],
    registration_id: '33333333-3333-4333-8333-333333333333',
    registration_number: 'EU123456',
  }
}

function get(filingId: string): Promise<Response> {
  return GET(
    new Request(`http://openbooks.test/api/tax/filings/${filingId}/export?format=csv`),
    { params: Promise.resolve({ id: filingId }) },
  )
}

test('export denominates frozen boxes in the frozen currency, not the org base', async () => {
  exportState.filingRow = frozenRow()
  exportState.captured = null

  const response = await get(randomUUID())

  assert.equal(response.status, 200)
  const captured = exportState.captured!
  assert.equal(captured.functionalCurrency, 'EUR')
  assert.equal(captured.registrationNumber, 'EU123456')
  assert.equal(captured.registrationId, '33333333-3333-4333-8333-333333333333')
  assert.deepEqual(captured.subsidiaryIds, [SUB])
  assert.deepEqual(
    captured.translation,
    frozenRow().translation,
    'a translated view reprints its frozen translation evidence',
  )
})

test('a pre-snapshot filing without frozen currency is refused with the remedy', async () => {
  exportState.filingRow = { ...frozenRow(), functional_currency: null }
  exportState.captured = null

  const response = await get(randomUUID())

  assert.equal(response.status, 422)
  assert.match(await response.text(), /prepare a new version/)
  assert.equal(exportState.captured, null, 'no export is rendered without an honest denomination')
})

test('a v1 row reprints with no invented registration identity', async () => {
  exportState.filingRow = {
    ...frozenRow(),
    functional_currency: 'CAD',
    translation: null,
    subsidiary_ids: null,
    registration_id: null,
    registration_number: null,
  }
  exportState.captured = null

  const response = await get(randomUUID())

  assert.equal(response.status, 200)
  const captured = exportState.captured!
  assert.equal(captured.functionalCurrency, 'CAD')
  assert.equal(captured.registrationNumber, null)
  assert.equal(captured.registrationId, null)
  assert.deepEqual(captured.subsidiaryIds, [])
  assert.equal(captured.translation, null)
})
