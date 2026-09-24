import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'

/**
 * Frozen-filing export stamping: the PDF generation stamp and the workbook
 * created/modified pair carry the org business day — never the render
 * instant's UTC day.
 */

const STAMP = '2026-03-15'
const EXPECTED_STAMP = new Date(`${STAMP}T00:00:00Z`)
const filingKey = Symbol.for('openbooks.filing-export-stamp-test')
const filingState: { pdfStamps: unknown[] } = { pdfStamps: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[filingKey] = filingState

const reportPdfUrl = new URL('./report-pdf.ts', import.meta.url).href
const businessDateUrl = import.meta.resolve('@openbooks/engine/src/platform/business-date.ts')
const dbUrl = import.meta.resolve('@openbooks/engine/src/platform/db.ts')

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksFilingStampSqlText = sqlText

const SUB = '11111111-1111-4111-8111-111111111111'

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      import { NextResponse } from 'next/server'
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  [
    'mock:db',
    `
      export * from '${dbUrl}'
      const sqlText = globalThis.openbooksFilingStampSqlText
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          if (text.includes('from tax_filings')) {
            return { rows: [{
              form_code: 'VAT100',
              form_name: 'VAT100',
              period_from: '2026-01-01',
              period_to: '2026-03-31',
              submission_channel: 'portal_manual',
              boxes: [{ lineCode: '1', label: 'Box 1', value: '100.0000', computed: true, editable: false }],
              snapshot_hash: 'hash-1',
              version: 3,
              functional_currency: 'EUR',
              translation: null,
              subsidiary_ids: ['${SUB}'],
              registration_id: null,
              registration_number: null,
            }] }
          }
          throw new Error('unexpected filing export query: ' + text.slice(0, 120))
        },
      }
    `,
  ],
  [
    'mock:report-pdf',
    `
      export * from '${reportPdfUrl}'
      const state = globalThis[Symbol.for('openbooks.filing-export-stamp-test')]
      export async function exportDataToPdf(data, branding, page, opts) {
        state.pdfStamps.push(opts.generatedAt)
        return Buffer.from('PDF-CANNED')
      }
      export async function orgBranding() { return { orgName: 'Test Org', primaryColor: '#111827' } }
    `,
  ],
])

const SELF_URL = new URL(import.meta.url).href
const mockUrl = (name: string) => `${SELF_URL}?mock=${name}`
const mockUrls = new Map<string, string>([
  ['../../../../../../lib/authz', mockUrl('authz')],
  ['@openbooks/engine/src/platform/db.ts', mockUrl('db')],
  ['../../../../../../lib/report-pdf', mockUrl('report-pdf')],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next-intl/server') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function getTranslations() { return (key) => key }',
      }
    }
    if (specifier === '@openbooks/engine/src/platform/business-date.ts') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export * from '${businessDateUrl}'; export async function businessToday() { return '${STAMP}' }`,
      }
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

const filingExportUrl = '../app/api/tax/filings/[id]/export/route.ts?filing-export-stamp'
const { GET } = (await import(filingExportUrl)) as typeof import('../app/api/tax/filings/[id]/export/route.ts')
hooks.deregister()

const get = (format: string) =>
  GET(new Request(`http://openbooks.test/api/tax/filings/${randomUUID()}/export?format=${format}`), {
    params: Promise.resolve({ id: randomUUID() }),
  })

test('filing PDF export stamps generation from the org business day', async () => {
  filingState.pdfStamps = []

  const response = await get('pdf')

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/pdf/)
  assert.match(response.headers.get('content-disposition') ?? '', new RegExp(STAMP))
  assert.deepEqual(filingState.pdfStamps, [EXPECTED_STAMP])
})

test('filing xlsx export stamps workbook created and modified from the org business day', async () => {
  const response = await get('xlsx')

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-disposition') ?? '', new RegExp(STAMP))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer)
  assert.deepEqual(workbook.created, EXPECTED_STAMP)
  assert.deepEqual(workbook.modified, EXPECTED_STAMP)
})
