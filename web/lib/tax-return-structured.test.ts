import assert from 'node:assert/strict'
import test from 'node:test'
import type { TaxReturnResult } from '@openbooks/engine/src/tax-return.ts'
import { taxReturnToStructured } from './tax-return-structured.ts'

function gstr(): TaxReturnResult {
  return {
    formCode: 'IN_GSTR3B',
    formName: 'GSTR-3B — Monthly Summary Return',
    from: '2026-07-01',
    to: '2026-07-31',
    submissionChannel: 'efile_api',
    watermark: 'Working copy — file on the GST portal',
    boxes: [
      { lineCode: '3.1A', label: 'Outward taxable supplies — taxable value', value: '500000.0000', computed: false, editable: false, pdfField: null },
      { lineCode: 'OUT', label: 'Output tax on outward supplies', value: '90000.0000', computed: false, editable: false, pdfField: null },
      { lineCode: '4A5', label: 'ITC Available — all other ITC', value: '30000.0000', computed: false, editable: false, pdfField: null },
      { lineCode: '4C', label: 'Net ITC Available', value: '30000.0000', computed: true, editable: false, pdfField: null },
      { lineCode: '6.1', label: 'Tax payable', value: '60000.0000', computed: true, editable: false, pdfField: null },
    ],
  }
}

test('structured export preserves numeric values and flags computed boxes', () => {
  const s = taxReturnToStructured(gstr())
  assert.equal(s.form.code, 'IN_GSTR3B')
  assert.equal(s.period.from, '2026-07-01')
  assert.equal(s.boxes.length, 5)
  const out = s.boxes.find((b) => b.line === 'OUT')!
  assert.equal(out.value, 90000) // a number, not a string
  assert.equal(out.computed, false)
  assert.equal(s.boxes.find((b) => b.line === '4C')!.computed, true)
})

test('net line resolves to the return-specific payable box (GSTR-3B line 6.1)', () => {
  const s = taxReturnToStructured(gstr())
  assert.equal(s.net?.line, '6.1')
  assert.equal(s.net?.value, 60000)
})

test('boxes without a layout fall into a single untitled section', () => {
  const s = taxReturnToStructured(gstr())
  // No facsimile layout is registered for IN_GSTR3B → one untitled section.
  assert.equal(s.sections.length, 1)
  assert.equal(s.sections[0].title, null)
  assert.equal(s.sections[0].boxes.length, 5)
  assert.equal(s.basis, 'working-copy')
  assert.match(s.notice ?? '', /GST portal/)
})
