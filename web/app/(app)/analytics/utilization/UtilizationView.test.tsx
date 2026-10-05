import assert from 'node:assert/strict'
import test from 'node:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { add } from '@openbooks/engine/src/money/money.ts'
import type { UtilizationData } from '../../../../lib/analytics/utilization-data'

const React = await import('react')
Object.assign(globalThis, { React })
const { NextIntlClientProvider } = await import('next-intl')
const messages = (await import('../../../../messages/en')).default
const { MoneyProvider } = await import('../../../../components/money-provider')
const { UtilizationView } = await import('./UtilizationView')

// a 0% utilization with no tracked hours is a data prerequisite, not
// a failing team. The overview names the missing time data and links the
// timesheets that change it — only when the range is actually empty.

function stat(hours: number) {
  return {
    hours,
    billableHours: 0,
    nonBillableHours: hours,
    percentBilled: 0,
    nonBillableCost: '0.0000',
    nonBillableCostPerDay: '0.0000',
    nonBillableCostPerHour: '0.0000',
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
      deltas: { pctDelta: 0, costDelta: '0.0000' },
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

function dataWithDepartmentCosts(costs: string[]): UtilizationData {
  const data = dataWithHours(costs.length * 40)
  data.company.range.billableHours = costs.length * 20
  data.company.range.nonBillableHours = costs.length * 20
  data.company.range.percentBilled = 50
  data.company.range.nonBillableCost = costs.reduce((total, cost) => add(total, cost), '0.0000')
  data.departments = costs.map((cost, index) => ({
    id: `department-${index}`,
    name: ['Engineering', 'Field Services', 'Operations'][index]!,
    range: { ...stat(40), billableHours: 20, nonBillableHours: 20, percentBilled: 50, nonBillableCost: cost },
    prior: stat(40),
    deltas: { pctDelta: 50, costDelta: cost },
    meetsMinHours: true,
    noBillable: false,
  }))
  return data
}

test('populated departments with zero non-billable costs render zero-width cost bars', () => {
  const html = render(<UtilizationView data={dataWithDepartmentCosts(['0.0000', '0.0000'])} />)
  assert.match(html, /Engineering/)
  assert.match(html, /Field Services/)
  assert.equal((html.match(/style="width:0%"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /NaN|Infinity/)
})

test('department cost bars preserve relative costs and show no bar for zero cost', () => {
  const html = render(<UtilizationView data={dataWithDepartmentCosts(['100.0000', '25.0000', '0.0000'])} />)
  assert.ok(html.includes('style="width:100%"'), 'The highest department cost must fill the bar')
  assert.ok(html.includes('style="width:25%"'), 'A quarter of the highest cost must render a quarter-width bar')
  assert.ok(html.includes('style="width:0%"'), 'A zero department cost must render an empty bar')
})

test('a positive department cost retains a visible bar when its relative ratio rounds to zero', () => {
  const html = render(<UtilizationView data={dataWithDepartmentCosts(['99999999999999.0000', '0.0001'])} />)
  assert.ok(html.includes('style="width:2%"'), 'A small positive cost must retain the minimum visible bar')
})
