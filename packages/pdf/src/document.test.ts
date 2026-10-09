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

test('shared styled cells and multi-observation segments render real readable PDFs with contrast-aware colors', async () => {
  const { pdfContrastText } = await import('./color');
  assert.equal(pdfContrastText('#000000'), '#ffffff');
  assert.equal(pdfContrastText('#ffffff'), '#000000');
  const pdf = await renderPdfDocument({
    title: 'Resource allocation', dateRangeLabel: 'October 2026', generatedAt: new Date('2026-10-12T10:00:00Z'),
    branding: { orgName: 'Example Company', primaryColor: '#7c3aed' }, design: 'modern',
    legend: { title: 'Configured colors', items: [{ label: 'Service', color: '#1d4ed8' }] },
    groups: [{ kind: 'section', title: 'Resources', columns: ['Resource', 'Assignments'], columnWeights: [1, 2], overflow: 'refuse',
      rows: [[{ text: 'Equipment A', bold: true }, { text: 'Morning\nAfternoon', segments: [
        { text: 'Morning', backgroundColor: '#1d4ed8' }, { text: 'Afternoon', backgroundColor: '#fde68a' },
      ] }]], columnStyles: [{ body: { backgroundColor: '#f1f5f9' } }, {}] }],
    layout: resolvePdfPageSetup({ paperSize: 'a4', orientation: 'landscape', marginMm: 10 }),
  });
  assert.equal((await ParsedPdf.load(pdf)).getPageCount(), 1);
});

test('oversized segmented cells refuse even in generic ellipsis groups instead of paginating inside a row', async () => {
  await assert.rejects(renderPdfDocument({
    title: 'Exact observations', dateRangeLabel: 'October 2026', generatedAt: new Date('2026-10-12T10:00:00Z'),
    branding: { orgName: 'Example Company' },
    groups: [{ kind: 'results', title: 'Observations', columns: ['Evidence'], overflow: 'ellipsis', rows: [[{
      text: 'Native evidence', segments: [{ text: 'Observation\n'.repeat(500), backgroundColor: '#1d4ed8' }],
    }]] }],
    layout: resolvePdfPageSetup({ paperSize: 'letter', orientation: 'portrait', marginMm: 15 }),
  }), /no report evidence was truncated/);
});
