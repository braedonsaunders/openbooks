import assert from 'node:assert/strict'
import test from 'node:test'

// F2-14b (setup preview quantities): integer grouping must follow the
// viewer's locale — "50 000" for a French viewer, never pinned "50,000".
const React = await import('react')
Object.assign(globalThis, { React })
const { renderToStaticMarkup } = await import('react-dom/server')
const { NextIntlClientProvider } = await import('next-intl')
const { MoneyProvider } = await import('@/components/money-provider')
const { DerivedRulePreviewTable } = await import('./DerivedRulePreviewTable')

const labels = {
  employee: 'Employee',
  jobTitle: 'Job',
  day: 'Day',
  project: 'Project',
  quantity: 'Quantity',
  amount: 'Amount',
  total: 'Total',
  empty: 'Empty',
}

const rows = [
  {
    employeePartyId: 'p1',
    employeeName: 'A. Example',
    jobTitle: null,
    day: '2026-01-05',
    quantity: '50000',
    amount: '100.0000',
    projectId: null,
    projectName: null,
  },
]

function markup(locale: string): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={{}} timeZone="UTC">
      <MoneyProvider currency="USD">
        <DerivedRulePreviewTable rows={rows} total="100.0000" labels={labels} />
      </MoneyProvider>
    </NextIntlClientProvider>,
  )
}

test('preview quantities group in the viewer locale (F2-14b)', () => {
  const en = markup('en-US')
  const fr = markup('fr')
  assert.ok(en.includes('50,000'), 'English render must group with commas')
  assert.ok(!fr.includes('50,000'), 'no pinned English grouping may leak into the French render')
  assert.match(fr, /50[ \u202f]000/)
})
