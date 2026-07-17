import { PDFDocument, PDFName } from 'pdf-lib'
import type { TaxReturnBox } from '@openbooks/engine/src/tax-return.ts'

/**
 * Fill a tenant-uploaded official government AcroForm PDF with the computed
 * return values and flatten it. The tenant supplies the copy they're entitled to
 * (openbooks never bundles government PDFs — Crown copyright, personalized forms,
 * and XFA make that wrong), maps each box to its field via tax_report_lines.pdf_field,
 * and openbooks fills it. Dynamic XFA/LiveCycle forms have no fillable AcroForm
 * fields and are rejected with a clear message rather than producing a blank PDF.
 */

export class OfficialPdfError extends Error {
  readonly name = 'OfficialPdfError'
}

/** Government forms show whole-dollar/2-decimal amounts; render the box value so. */
function fmtAmount(v: string): string {
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(2) : v
}

export interface FillResult {
  bytes: Uint8Array
  filled: number
  unmatched: string[]
}

export async function fillOfficialTaxPdf(pdfBytes: Uint8Array, boxes: TaxReturnBox[]): Promise<FillResult> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(pdfBytes)
  } catch (e) {
    throw new OfficialPdfError(`could not read the uploaded PDF: ${e instanceof Error ? e.message : String(e)}`)
  }
  const form = doc.getForm()
  // Static/hybrid XFA: disconnect it so readers fall back to the AcroForm we fill.
  try {
    if (form.acroForm.dict.has(PDFName.of('XFA'))) form.deleteXFA()
  } catch {
    /* no XFA / not accessible — proceed */
  }

  const fields = form.getFields()
  if (fields.length === 0) {
    throw new OfficialPdfError(
      'this PDF has no fillable form fields — it may be a dynamic XFA/LiveCycle form, which cannot be filled. Use the facsimile instead.',
    )
  }
  const fieldNames = new Set(fields.map((f) => f.getName()))

  let filled = 0
  const unmatched: string[] = []
  for (const box of boxes) {
    if (!box.pdfField) continue
    if (!fieldNames.has(box.pdfField)) {
      unmatched.push(box.pdfField)
      continue
    }
    try {
      form.getTextField(box.pdfField).setText(fmtAmount(box.value))
      filled++
    } catch {
      // Not a text field (checkbox/radio/dropdown) — unsupported for v1; skip.
      unmatched.push(box.pdfField)
    }
  }

  // Bake values into the page content so every reader/printer renders identically.
  form.flatten()
  const bytes = await doc.save()
  return { bytes, filled, unmatched }
}
