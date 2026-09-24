import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { UtilizationData } from '../../../../lib/analytics/utilization-data'

const React = await import('react')
Object.assign(globalThis, { React })
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { UtilizationView } = await import('./UtilizationView')

// UX-20: a 0% utilization with no tracked hours is a data prerequisite, not
// a failing team. The overview names the missing time data and links the
// timesheets that change it — only when the range is actually empty.

function stat(hours: number) {
  return {
    hours,
    billableHours: 0,
    nonBillableHours: hours,
    percentBilled: 0,
    nonBillableCost: 0,
    nonBillableCostPerDay: 0,
    nonBillableCostPerHour: 0,
  }
}

function dataWithHours(hours: number): UtilizationData {
  return {
    period: { from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026', days: 31 },
    prior: { from: '2026-06-01', to: '2026-06-30' },
    config: { target: 75, costSpike: 20, minHours: 1 },
    company: {
      range: stat(hours),
      prior: stat(hours),
      deltas: { pctDelta: 0, costDelta: 0 },
      alerts: [],
    },
    departments: [],
    items: [],
    employees: [],
    history: { periodMonths: 0, periods: [] },
  } as unknown as UtilizationData
}

function render(ui: ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MoneyProvider currency="USD">{ui}</MoneyProvider>
    </NextIntlClientProvider>,
  )
}

test('an empty range names the missing time data and links the timesheets that fix it', () => {
  const html = render(<UtilizationView data={dataWithHours(0)} />)
  assert.match(html, /No time was tracked in this period/)
  assert.match(html, /href="\/timesheets"/)
  assert.match(html, /Open timesheets/)
})

test('tracked hours render no prerequisite note', () => {
  const html = render(<UtilizationView data={dataWithHours(40)} />)
  assert.doesNotMatch(html, /No time was tracked in this period/)
  assert.doesNotMatch(html, /href="\/timesheets"/)
})
