import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'

/**
 * Computed-return export stamping: the PDF generation stamp and the
 * workbook created/modified pair carry the org business day — never the
 * render instant's UTC day.
 */

const STAMP = '2026-03-15'
const EXPECTED_STAMP = new Date(`${STAMP}T00:00:00Z`)
const returnKey = Symbol.for('openbooks.return-export-stamp-test')
const returnState: { pdfStamps: unknown[] } = { pdfStamps: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[returnKey] = returnState

const reportPdfUrl = new URL('./report-pdf.ts', import.meta.url).href
const businessDateUrl = import.meta.resolve('@openbooks/engine/src/platform/business-date.ts')

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
    'mock:compute-return',
    `
      export async function computeTaxReturn(orgId, code, from, to) {
        return {
          formCode: code,
          formName: code,
          from,
          to,
          submissionChannel: 'portal_manual',
          watermark: null,
          registrationNumber: null,
          functionalCurrency: 'EUR',
          subsidiaryIds: [],
          registrationId: null,
          translation: null,
          boxes: [{ lineCode: '1', label: 'Box 1', value: '100.0000', computed: true, editable: false, pdfField: null }],
        }
      }
    `,
  ],
  [
    'mock:report-pdf',
    `
      export * from '${reportPdfUrl}'
      const state = globalThis[Symbol.for('openbooks.return-export-stamp-test')]
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
  ['@openbooks/engine/src/tax-returns/return.ts', mockUrl('compute-return')],
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

const returnExportUrl = '../app/api/tax/returns/[code]/export/route.ts?return-export-stamp'
const { GET } = (await import(returnExportUrl)) as typeof import('../app/api/tax/returns/[code]/export/route.ts')
hooks.deregister()

const get = (format: string) =>
  GET(
    new Request(`http://openbooks.test/api/tax/returns/VAT100/export?from=2026-01-01&to=2026-03-31&format=${format}`),
    { params: Promise.resolve({ code: 'VAT100' }) },
  )

test('return PDF export stamps generation from the org business day', async () => {
  returnState.pdfStamps = []

  const response = await get('pdf')

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/pdf/)
  assert.match(response.headers.get('content-disposition') ?? '', new RegExp(STAMP))
  assert.deepEqual(returnState.pdfStamps, [EXPECTED_STAMP])
})

test('return xlsx export stamps workbook created and modified from the org business day', async () => {
  const response = await get('xlsx')

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-disposition') ?? '', new RegExp(STAMP))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()) as unknown as ArrayBuffer)
  assert.deepEqual(workbook.created, EXPECTED_STAMP)
  assert.deepEqual(workbook.modified, EXPECTED_STAMP)
})
