import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { obligationPeriodForForm } from './TaxFilingsView.tsx'

const viewSource = readFileSync(
  new URL('./TaxFilingsView.tsx', import.meta.url),
  'utf8',
)

test('period lookup uses the selected form obligation, not another form', () => {
  const obligations = [
    {
      returnFormCode: 'CA_GST34',
      reportableFrom: '2026-04-01',
      reportableTo: '2026-06-30',
    },
    {
      returnFormCode: 'GB_VAT100',
      reportableFrom: '2026-05-01',
      reportableTo: '2026-06-30',
    },
  ]

  assert.deepEqual(obligationPeriodForForm(obligations, 'GB_VAT100'), {
    from: '2026-05-01',
    to: '2026-06-30',
  })
})

test('a form without an obligation does not inherit the last response entry', () => {
  const obligations = [
    {
      returnFormCode: 'CA_GST34',
      reportableFrom: '2026-04-01',
      reportableTo: '2026-06-30',
    },
  ]

  assert.equal(obligationPeriodForForm(obligations, 'GB_VAT100'), null)
  assert.doesNotMatch(
    viewSource,
    /data\.obligations\[data\.obligations\.length - 1\]/,
  )
})

test('changing forms starts from the neutral business-month bounds', () => {
  assert.match(viewSource, /setFrom\(bounds\.from\)/)
  assert.match(viewSource, /setTo\(bounds\.to\)/)
})
