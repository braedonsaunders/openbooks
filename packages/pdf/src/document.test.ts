import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument as ParsedPdf } from 'pdf-lib'
import { renderPdfDocument } from './document'
import { resolvePdfPageSetup } from './types'

test('footer stamping does not append blank pages', async () => {
  const pdf = await renderPdfDocument({
    title: 'Management summary',
    dateRangeLabel: 'May 2026',
    generatedAt: new Date('2026-07-17T12:00:00Z'),
    branding: { orgName: 'Example Company' },
    summary: [{ label: 'Agent', value: 'Finance' }],
    groups: [{
      kind: 'section',
      title: 'Executive summary',
      columns: [''],
      rows: [['A concise report that fits on one content page.']],
      align: ['left'],
    }],
    layout: resolvePdfPageSetup({
      paperSize: 'letter',
      orientation: 'portrait',
      marginMm: 16,
      density: 'standard',
    }),
  })
  const parsed = await ParsedPdf.load(pdf)
  assert.equal(parsed.getPageCount(), 1)
})
