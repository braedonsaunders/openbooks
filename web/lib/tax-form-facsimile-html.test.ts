import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaxReturnResult } from '@openbooks/engine/src/tax-return.ts'
import {
  fmtFacsimileAmount,
  renderTaxFormFacsimileBody,
  renderTaxFormFacsimileHtml,
  TAX_FORM_LAYOUTS,
} from './tax-form-facsimile-html.ts'

function result(overrides: Partial<TaxReturnResult> = {}): TaxReturnResult {
  return {
    formCode: 'CA_GST34',
    formName: 'GST/HST Return (GST34)',
    from: '2026-07-01',
    to: '2026-07-31',
    submissionChannel: 'portal_manual',
    watermark: 'Working copy — file electronically through the CRA',
    registrationNumber: null,
    functionalCurrency: 'CAD',
    subsidiaryIds: [],
    registrationId: null,
    translation: null,
    boxes: [
      { lineCode: '101', label: 'Sales and other revenue', value: '1837186.5000', computed: false, editable: false, pdfField: null },
      { lineCode: '103', label: 'GST/HST collected', value: '238834.2600', computed: false, editable: false, pdfField: null },
      { lineCode: '104', label: 'Adjustments added', value: '0.0000', computed: false, editable: true, pdfField: null },
      { lineCode: '109', label: 'Net tax', value: '204935.9600', computed: true, editable: false, pdfField: null },
    ],
    ...overrides,
  }
}

test('amounts format with separators, 2 decimals, and parentheses for negatives', () => {
  assert.equal(fmtFacsimileAmount('1837186.5000'), '1,837,186.50')
  assert.equal(fmtFacsimileAmount('0.0000'), '0.00')
  assert.equal(fmtFacsimileAmount('-204.5000'), '(204.50)')
})

test('facsimile amounts preserve exact box decimals through generic and GST34 renderers', () => {
  const exact = '9007199254740993.1234'
  const exactResult = result({
    boxes: [{ lineCode: '101', label: 'Sales and other revenue', value: exact, computed: false, editable: false, pdfField: null }],
  })

  // A floating-point coercion rounds to ...994 before formatting; the working return must
  // print the exact mathematical value rounded only to the form's two places.
  assert.equal(fmtFacsimileAmount(exact), '9,007,199,254,740,993.12')
  assert.match(renderTaxFormFacsimileHtml(exactResult, null), /9,007,199,254,740,993\.12/)
  assert.match(renderTaxFormFacsimileBody(exactResult), /9,007,199,254,740,993\.12/)

  // Fractional box values use the same exact path (2.675 must round up).
  assert.equal(fmtFacsimileAmount('2.675'), '2.68')
  assert.equal(fmtFacsimileAmount('-2.675'), '(2.68)')
  assert.equal(fmtFacsimileAmount('-0.0000'), '0.00')
})

test('facsimile renders every box with its line number, label and amount', () => {
  const html = renderTaxFormFacsimileHtml(result(), TAX_FORM_LAYOUTS.CA_GST34!, { orgName: 'Example Organization' })
  assert.match(html, /Canada Revenue Agency/)
  assert.match(html, /NET TAX CALCULATION/)
  assert.match(html, /1,837,186\.50/)
  assert.match(html, />101</)
  assert.match(html, /Example Organization/)
  // The not-for-filing watermark must be present.
  assert.match(html, /Working copy/)
})

test('unknown forms still render via the generic layout (no bespoke entry needed)', () => {
  const r = result({ formCode: 'ZZ_UNKNOWN', formName: 'Some VAT Return', watermark: null })
  const html = renderTaxFormFacsimileHtml(r, null)
  assert.match(html, /Some VAT Return/)
  assert.match(html, /238,834\.26/)
  // Every box appears even without a section map.
  assert.match(html, /Net tax/)
})

test('GST34 uses the bespoke CRA renderer (masthead, sections, chips, form code)', () => {
  const html = renderTaxFormFacsimileBody(result(), { orgName: 'Example Organization' })
  assert.match(html, /Canada Revenue Agency/)
  assert.match(html, /Agence du revenu du Canada/)
  assert.match(html, /RETURN FOR REGISTRANTS/)
  assert.match(html, /NET TAX CALCULATION/)
  assert.match(html, /OTHER CREDITS IF APPLICABLE/)
  assert.match(html, /OTHER DEBITS IF APPLICABLE/)
  assert.match(html, /REFUND CLAIMED/)
  assert.match(html, /PAYMENT ENCLOSED/)
  assert.match(html, /GST34-1 E \(02\)/)
  assert.match(html, /width:780px/) // fixed CRA canvas
  assert.match(html, /1,837,186\.50/) // line 101 value formatted
})

test('a form with no bespoke renderer falls back to the generic layout', () => {
  const r = result({ formCode: 'GB_VAT100', formName: 'VAT Return (VAT100)', watermark: null })
  const html = renderTaxFormFacsimileBody(r, null)
  assert.doesNotMatch(html, /width:780px/) // not the GST34 canvas
  assert.match(html, /VAT Return \(VAT100\)/)
})

test('dynamic content is HTML-escaped (no injection from labels)', () => {
  const r = result({
    boxes: [{ lineCode: '1', label: '<script>x</script>', value: '1.0000', computed: false, editable: false, pdfField: null }],
  })
  const html = renderTaxFormFacsimileHtml(r, null)
  assert.doesNotMatch(html, /<script>x<\/script>/)
  assert.match(html, /&lt;script&gt;/)
})

test('GST34 prints the registered business number, never a fabricated one', () => {
  // The facsimile must identify the return with the org's own CRA registration
  // from tax_registrations — a made-up number on a government-form replica
  // could be copied into a real filing.
  const html = renderTaxFormFacsimileBody(
    result({ registrationNumber: '123456789 RT0001' }),
    { orgName: 'Example Organization' },
  )
  assert.match(html, /123456789 RT0001/)
  assert.doesNotMatch(html, /00000 0000 000000/)
})

test('GST34 without a registration prints a blank business number, not zeros', () => {
  const html = renderTaxFormFacsimileBody(result({ registrationNumber: null }), { orgName: 'Example Organization' })
  assert.doesNotMatch(html, /00000 0000 000000/)
})

test('GST34 unsigned lines never hide a negative sign', () => {
  // Net refunds can drive an unsigned line (sales base, collected tax, their
  // subtotal) negative, and the API accepts negative adjustments — the
  // bespoke renderer must surface the sign like the generic path does, never
  // collapse it to the absolute value. Only the NET TAX balance line keeps
  // the CRA minus-box convention.
  const r = result({
    boxes: [
      { lineCode: '101', label: 'Sales and other revenue', value: '-50.0000', computed: false, editable: false, pdfField: null },
      { lineCode: '103', label: 'GST/HST collected', value: '-6.5000', computed: false, editable: false, pdfField: null },
      { lineCode: '105', label: 'Total GST/HST and adjustments', value: '-56.5000', computed: true, editable: false, pdfField: null },
      { lineCode: '109', label: 'Net tax', value: '-10.0000', computed: true, editable: false, pdfField: null },
    ],
  })
  const html = renderTaxFormFacsimileBody(r, { orgName: 'Example Organization' })
  assert.match(html, /\(50\.00\)/)
  assert.match(html, /\(6\.50\)/)
  assert.match(html, /\(56\.50\)/)
  assert.doesNotMatch(html, />50\.00</)
  assert.doesNotMatch(html, />56\.50</)
  // The balance line still uses the CRA minus box, not parentheses.
  assert.match(html, /&minus;/)
})

test('GST34 leaves unconfigured lines blank instead of printing zero', () => {
  // Only configured boxes are computed measurements — a line the return never
  // produced (e.g. rebates, deleted from the org's form config) must not
  // print a fabricated 0.00 that reads as a computed zero. The row stays so
  // the form keeps its shape; only the amount cell is blank.
  const r = result({
    boxes: [
      { lineCode: '101', label: 'Sales and other revenue', value: '1000.0000', computed: false, editable: false, pdfField: null },
    ],
  })
  const html = renderTaxFormFacsimileBody(r, { orgName: 'Example Organization' })
  assert.match(html, />111</) // the rebates row is still on the form
  assert.doesNotMatch(html, />0\.00</) // …but no uncomputed line prints zero
})
