import type { PayrollFilingSlipData } from '@openbooks/engine/src/payroll-filing-registry.ts'
import type { TaxReturnResult } from '@openbooks/engine/src/tax-return.ts'
import { TAX_FORM_LAYOUTS, type TaxFormLayout } from './tax-form-facsimile-html'

/**
 * Adapt a payroll filing's slip render (the registry's declared box data) to
 * the shared form-faithful facsimile pathway — the SAME renderer the
 * indirect-tax returns print through (tax-form-facsimile-html.ts): every box
 * with its number, label and amount, agency masthead, working-copy watermark.
 *
 * Pure, client-safe: the year-end drawer renders the HTML in the browser and
 * the slip API route prints the identical body to PDF through Chromium.
 */
export function payrollSlipFacsimile(
  slip: PayrollFilingSlipData,
  taxYear: number,
): { result: TaxReturnResult; layout: TaxFormLayout } {
  const base = TAX_FORM_LAYOUTS[slip.formCode]
  const layout: TaxFormLayout = {
    ...base,
    agency: base?.agency ?? '',
    formNumber: slip.formNumber ?? base?.formNumber,
    // The slip's own identification values (employee, account, year) replace
    // the layout's static header labels.
    headerFields: slip.headerFields,
    footerNotes: [...(slip.notes ?? []), ...(base?.footerNotes ?? [])],
  }
  return {
    result: {
      formCode: slip.formCode,
      formName: slip.formName,
      from: `${taxYear}-01-01`,
      to: `${taxYear}-12-31`,
      submissionChannel: 'none',
      watermark: 'Working copy — not for filing',
      boxes: slip.boxes.map((box) => ({
        lineCode: box.code,
        label: box.label,
        value: box.value,
        computed: box.emphasis === true,
        editable: false,
        pdfField: null,
      })),
    },
    layout,
  }
}
