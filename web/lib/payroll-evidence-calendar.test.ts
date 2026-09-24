import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * Pay-run evidence stamping: every PDF in the approval package (the two
 * report definitions plus the GL preview) carries the org business day as
 * its generation stamp — never the render instant's UTC day.
 */

const STAMP = '2026-03-15'
const evidenceKey = Symbol.for('openbooks.payroll-evidence-stamp-test')
const evidenceState: { stamps: unknown[]; uploaded: unknown } = { stamps: [], uploaded: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[evidenceKey] = evidenceState

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
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksEvidenceSqlText = sqlText

// Absolute URL of pdf-lib: mock modules load from opaque `mock:` URLs with
// no base, so bare specifiers inside them cannot resolve. Only pdf-lib is
// imported there (to mint the tiny merged fixture); everything else the
// package under test needs is captured or canned above.
const pdfLibUrl = import.meta.resolve('pdf-lib')

const mockSources = new Map<string, string>([
  ['mock:server-only', 'export {}'],
  [
    'mock:intl',
    'export async function getTranslations() { return (key) => key }',
  ],
  [
    'mock:business-date',
    `export async function businessToday() { return '${STAMP}' }`,
  ],
  [
    'mock:ensure-definitions',
    'export async function ensureReportDefinitions() {}',
  ],
  [
    'mock:run-commit',
    'export async function previewPayRunGl() { return { debitTotal: "0.0000", legs: [] } }',
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-evidence-stamp-test')]
      const sqlText = globalThis.openbooksEvidenceSqlText
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          if (text.includes('from pay_runs r')) {
            return { rows: [{
              document_number: 'RUN-7',
              period_start: '2026-03-01',
              period_end: '2026-03-31',
              pay_date: '2026-04-02',
              run_status: 'calculated',
            }] }
          }
          if (text.includes('from report_definitions')) {
            return { rows: [
              { slug: 'payroll-journal', id: 'def-journal', name: 'Payroll journal' },
              { slug: 'payroll-register', id: 'def-register', name: 'Payroll register' },
            ] }
          }
          throw new Error('unexpected evidence query: ' + text.slice(0, 120))
        },
      }
    `,
  ],
  [
    'mock:report-run',
    `
      export async function resolveDefinitionToExportData() {
        return { title: 'Evidence', dateRangeLabel: '', summary: [], groups: [] }
      }
    `,
  ],
  [
    'mock:report-pdf',
    `
      import { PDFDocument } from '${pdfLibUrl}'
      const state = globalThis[Symbol.for('openbooks.payroll-evidence-stamp-test')]
      const tiny = await (async () => {
        const doc = await PDFDocument.create()
        doc.addPage([200, 200])
        return Buffer.from(await doc.save())
      })()
      export async function exportDataToPdf(data, branding, page, opts) {
        state.stamps.push(opts.generatedAt)
        return tiny
      }
      export async function orgBranding() { return { orgName: 'Test Org', primaryColor: '#111827' } }
      export function resolveLayout() { return { page: {}, showSummary: true } }
    `,
  ],
  [
    'mock:periods',
    `
      export async function resolvePeriod(preset, opts) {
        return { from: opts.customFrom, to: opts.customTo, label: '' }
      }
    `,
  ],
  [
    'mock:file-cabinet',
    `
      const state = globalThis[Symbol.for('openbooks.payroll-evidence-stamp-test')]
      export async function uploadAndAttach(input) {
        state.uploaded = input
        return { id: 'file-1' }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['server-only', 'mock:server-only'],
  ['next-intl/server', 'mock:intl'],
  ['@openbooks/engine/src/platform/business-date.ts', 'mock:business-date'],
  ['@openbooks/engine/src/reports/ensure-report-definitions.ts', 'mock:ensure-definitions'],
  ['@openbooks/engine/src/payroll/run-commit.ts', 'mock:run-commit'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['./report-run', 'mock:report-run'],
  ['./report-pdf', 'mock:report-pdf'],
  ['./periods', 'mock:periods'],
  ['./file-cabinet', 'mock:file-cabinet'],
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

const evidenceUrl = './payroll-evidence.ts?payroll-evidence-stamp'
const { assemblePayRunEvidence } = (await import(evidenceUrl)) as typeof import('./payroll-evidence.ts')
hooks.deregister()

const EXPECTED_STAMP = new Date(`${STAMP}T00:00:00Z`)

test('every evidence PDF carries the org business day as its generation stamp', async () => {
  evidenceState.stamps = []
  evidenceState.uploaded = null

  const result = await assemblePayRunEvidence('org-1', 'user-1', 'doc-1')

  assert.equal(result.fileId, 'file-1')
  assert.equal(result.filename, 'RUN-7-payroll-evidence.pdf')
  assert.deepEqual(result.parts, ['Payroll journal', 'Payroll register', 'GL preview RUN-7'])
  assert.equal(evidenceState.stamps.length, 3, 'both definitions and the GL preview stamp their PDF')
  for (const stamp of evidenceState.stamps) {
    assert.deepEqual(stamp, EXPECTED_STAMP)
  }
})
