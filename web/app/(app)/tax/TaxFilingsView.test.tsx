import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildPrepareBody, exportScopeQuery, obligationPeriodForForm } from './TaxFilingsView.tsx'

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

// TR2: prepare freezes exactly what was previewed — the clamped window plus
// the preview's own filing scope — so an entity-scoped or translated preview
// is what gets filed, not the org-wide default.
test('prepare carries the preview window and filing scope', () => {
  assert.deepEqual(
    buildPrepareBody(
      'GST-Q',
      {
        from: '2026-07-16',
        to: '2026-07-31',
        subsidiaryIds: ['sub-a'],
        registrationId: 'reg-1',
        translation: { presentationCurrency: 'CAD', rateType: 'spot', rateDate: '2026-07-31' },
      },
      {},
    ),
    {
      code: 'GST-Q',
      from: '2026-07-16',
      to: '2026-07-31',
      adjustments: {},
      filingEntity: { subsidiaryIds: ['sub-a'], registrationId: 'reg-1' },
      translation: { presentationCurrency: 'CAD', rateType: 'spot', rateDate: '2026-07-31' },
    },
  )
})

test('prepare of an org-wide preview keeps the historical body shape', () => {
  assert.deepEqual(
    buildPrepareBody(
      'GST-Q',
      {
        from: '2026-07-01',
        to: '2026-07-31',
        subsidiaryIds: [],
        registrationId: null,
        translation: null,
      },
      { '101': '12.50' },
    ),
    {
      code: 'GST-Q',
      from: '2026-07-01',
      to: '2026-07-31',
      adjustments: { '101': '12.50' },
    },
  )
})

test('export carries the preview scope and translation the export route parses', () => {
  assert.equal(
    exportScopeQuery({
      subsidiaryIds: ['sub-a', 'sub-b'],
      registrationId: 'reg-1',
      translation: { presentationCurrency: 'CAD', rateType: 'spot', rateDate: '2026-07-31' },
    }),
    '&subsidiary=sub-a&subsidiary=sub-b&registration=reg-1' +
      '&presentationCurrency=CAD&rateType=spot&rateDate=2026-07-31',
  )
})

test('export of an org-wide preview contributes no scope params', () => {
  assert.equal(
    exportScopeQuery({ subsidiaryIds: [], registrationId: null, translation: null }),
    '',
  )
})

test('tax filing box display preserves exact decimal values', () => {
  assert.match(viewSource, /import \{ formatDecimal \} from ['"]\.\.\/\.\.\/\.\.\/lib\/money-format['"]/)
  assert.match(viewSource, /formatDecimal\(locale, value,/)
  assert.doesNotMatch(viewSource, /Number\(value\)\.toLocaleString/)
})
