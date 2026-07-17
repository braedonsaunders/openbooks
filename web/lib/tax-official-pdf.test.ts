import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFDocument } from 'pdf-lib'
import { fillOfficialTaxPdf, OfficialPdfError } from './tax-official-pdf.ts'
import type { TaxReturnBox } from '@openbooks/engine/src/tax-return.ts'

const box = (lineCode: string, value: string, pdfField: string | null): TaxReturnBox => ({
  lineCode,
  label: lineCode,
  value,
  computed: false,
  editable: false,
  pdfField,
})

/** Build an AcroForm PDF with the given text fields (a stand-in official form). */
async function makeFormPdf(fieldNames: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 400])
  const form = doc.getForm()
  let y = 350
  for (const name of fieldNames) {
    const tf = form.createTextField(name)
    tf.addToPage(page, { x: 20, y, width: 200, height: 20 })
    y -= 30
  }
  return doc.save()
}

test('fills mapped fields with 2-decimal amounts and flattens the form', async () => {
  const pdf = await makeFormPdf(['line_103', 'line_109'])
  const { bytes, filled, unmatched } = await fillOfficialTaxPdf(pdf, [
    box('103', '13000.0000', 'line_103'),
    box('109', '9000.0000', 'line_109'),
    box('101', '0.0000', null), // unmapped — ignored
  ])
  assert.equal(filled, 2)
  assert.deepEqual(unmatched, [])
  // Flattened → no live fields left in the output.
  const out = await PDFDocument.load(bytes)
  assert.equal(out.getForm().getFields().length, 0)
})

test('rejects a PDF that has no fillable fields (e.g. a dynamic XFA form)', async () => {
  const doc = await PDFDocument.create()
  doc.addPage()
  const flat = await doc.save()
  await assert.rejects(() => fillOfficialTaxPdf(flat, []), OfficialPdfError)
})

test('reports a mapped field that is not present in the uploaded PDF', async () => {
  const pdf = await makeFormPdf(['line_103'])
  const { filled, unmatched } = await fillOfficialTaxPdf(pdf, [box('999', '1.00', 'missing_field')])
  assert.equal(filled, 0)
  assert.deepEqual(unmatched, ['missing_field'])
})
