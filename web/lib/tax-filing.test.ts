import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import type { TaxReturnResult } from '@openbooks/engine/src/tax-return.ts'

// tax-filing.ts is server-only in production. Shim the marker so this pure
// adapter can be exercised directly by Node's test runner.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { taxReturnExportData } = await import('./tax-filing.ts')

const result: TaxReturnResult = {
  formCode: 'CA_GST34',
  formName: 'GST/HST Return (GST34)',
  from: '2026-07-01',
  to: '2026-07-31',
  submissionChannel: 'portal_manual',
  watermark: 'Working copy',
  boxes: [
    { lineCode: '101', label: 'Sales and other revenue', value: '9007199254740.9938', computed: false, editable: false, pdfField: null },
    { lineCode: '109', label: 'Net tax', value: '9007199254740.9938', computed: true, editable: false, pdfField: null },
  ],
}

const t = (key: string) => key

test('tax return export preserves exact statutory box strings and marks money columns', () => {
  const data = taxReturnExportData(result, t)

  assert.deepEqual(data.summary, [
    { label: 'Net tax', value: '9007199254740.9938', money: true },
    { label: 'notice', value: 'Working copy' },
  ])
  assert.deepEqual(data.groups[0]?.money, [false, false, true])
  assert.equal(data.groups[0]?.rows[0]?.[2], '9007199254740.9938')
  assert.equal(typeof data.groups[0]?.rows[0]?.[2], 'string')
})

test('tax return export prefers the 113C headline box over 109', () => {
  const data = taxReturnExportData({
    ...result,
    boxes: [
      ...result.boxes,
      { lineCode: '113C', label: 'Refund', value: '2.6750', computed: true, editable: false, pdfField: null },
    ],
  }, t)

  assert.deepEqual(data.summary[0], { label: 'Refund', value: '2.6750', money: true })
})
