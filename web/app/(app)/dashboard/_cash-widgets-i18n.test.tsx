import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'
import './_dashboard-render-harness'
import { mountDashboard } from './_dashboard-render-harness'
import type { DashboardMetrics } from './_metrics'

// The forecast chart draws on an ECharts canvas, which jsdom cannot host:
// stub the canvas host like the analytics view tests do. The tile shell,
// headline, context and the refusal below it still render for real.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@openbooks/analytics/viz') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function InsightChart(){return null}',
      }
    }
    return next(specifier, context)
  },
})

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { WidgetCard } = await import('./_widget-views')

const dir = dirname(fileURLToPath(import.meta.url));
const catalog = (locale: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(dir, '..', '..', '..', 'messages', locale, 'dashboard.json'), 'utf8'),
  ) as Record<string, unknown>;

function lowestData() {
  return {
    baseCurrency: 'USD',
    asOfDate: '2026-09-16',
    cashLowest: {
      available: true,
      value: { amount: '1234.5600', week: '2026-09-20', status: 'caution', horizonWeeks: 13 },
    },
  } as unknown as DashboardMetrics
}

// The lowest-point tile shows the Cash Flow position's own lowest projected
// cash and the week it occurs in — the same figure the dashboard's forecast
// chart flags — with the caution tone when the horizon reads caution.
test('lowest-point tile renders the position figure with its week', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-cash-lowest-point" data={lowestData()} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Lowest projected cash'), 'the tile title resolves through dashboard.widgets copy')
    assert.ok(html.includes('1,234.56'), 'the lowest amount renders as money, never raw')
    assert.ok(html.includes('week of Sep 20, 2026'), 'the hint names the week the low occurs in')
  } finally {
    await unmount()
  }
})

function burnData() {
  return {
    baseCurrency: 'USD',
    asOfDate: '2026-09-16',
    cashBurn: {
      available: true,
      value: { weeklyOutflow: '8450.2500', netChange: '-1234.5600', horizonWeeks: 13 },
    },
  } as unknown as DashboardMetrics
}

// The burn tile shows the average weekly outflow with the projected net
// change over the horizon as its hint — both from the same position.
test('burn tile renders the weekly outflow with the projected net change', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-cash-burn" data={burnData()} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Weekly cash burn'), 'the tile title resolves through dashboard.widgets copy')
    assert.ok(html.includes('8,450.25'), 'the weekly outflow renders as money, never raw')
    assert.ok(html.includes('Net -$1,234.56 over the horizon'), 'the hint carries the projected net change')
  } finally {
    await unmount()
  }
})

function coverageData() {
  return {
    baseCurrency: 'USD',
    asOfDate: '2026-09-16',
    cashCoverage: { available: true, value: { ratio: '1.8000', covered: true } },
  } as unknown as DashboardMetrics
}

// The coverage tile shows (cash + AR) / AP as a multiple — the cockpit's
// own ratio — and names it when there is nothing to cover.
test('coverage tile renders the position ratio as a multiple', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-cash-coverage" data={coverageData()} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Cash coverage'), 'the tile title resolves through dashboard.widgets copy')
    assert.ok(html.includes('1.80×'), 'the ratio renders as a multiple, never raw')
  } finally {
    await unmount()
  }
})

test('coverage tile names it when no payables are outstanding', async () => {
  const data = {
    ...coverageData(),
    cashCoverage: { available: false, reason: 'No payables outstanding — nothing to cover.' },
  } as unknown as DashboardMetrics
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-cash-coverage" data={data} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('No payables outstanding'), 'the tile names the missing input')
    assert.ok(!html.includes('×'), 'no ratio renders beside the refusal')
  } finally {
    await unmount()
  }
})

function settlementData() {
  return {
    baseCurrency: 'USD',
    asOfDate: '2026-09-16',
    cashCollectDays: { available: true, value: 38 },
    cashPayDays: { available: true, value: 41 },
  } as unknown as DashboardMetrics
}

// The settlement tile shows the mean days to collect and to pay side by
// side — each from its own history — and names the side that has none.
test('settlement tile renders both means from the catalog pattern', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-cash-settlement-days" data={settlementData()} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Settlement days'), 'the tile title resolves through dashboard.widgets copy')
    assert.ok(html.includes('Collect 38d · Pay 41d'), 'both means render in the catalog pattern')
  } finally {
    await unmount()
  }
})

test('settlement tile names the side with no history', async () => {
  const data = {
    ...settlementData(),
    cashCollectDays: { available: true, value: null },
  } as unknown as DashboardMetrics
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-cash-settlement-days" data={data} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Pay 41d'), 'the side with history still renders')
    assert.ok(html.includes('No collection history yet'), 'the missing side is named')
    assert.ok(!html.includes('Collect 38d'), 'no invented collect figure renders')
  } finally {
    await unmount()
  }
})

function forecastData() {
  return {
    baseCurrency: 'USD',
    asOfDate: '2026-09-16',
    cashForecast: {
      available: true,
      value: {
        weeks: [
          { label: 'Sep 14 – Sep 20', inflow: '5000.0000', outflow: '8450.2500', net: '-3450.2500', endingCash: '1234.5600' },
          { label: 'Sep 21 – Sep 27', inflow: '6000.0000', outflow: '5234.4400', net: '765.5600', endingCash: '2000.1200' },
        ],
        projectedEnd: '2000.1200',
        horizonWeeks: 13,
      },
    },
  } as unknown as DashboardMetrics
}

// The forecast chart is the Cash Flow dashboard's own chart (same option
// builder, same weekly rows): the headline is the projected end and the
// context names the horizon.
test('forecast chart renders the projected end with its horizon', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="chart-cash-forecast" data={forecastData()} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Cash forecast'), 'the tile title resolves through dashboard.widgets copy')
    assert.ok(html.includes('2,000.12'), 'the headline is the projected end as money')
    assert.ok(html.includes('13-week forecast'), 'the context names the horizon')
  } finally {
    await unmount()
  }
})

test('forecast chart refuses by name when the rate is missing', async () => {
  const data = {
    ...forecastData(),
    cashForecast: { available: false, reason: 'no spot rate for EUR→USD on or before 2026-09-16' },
  } as unknown as DashboardMetrics
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="chart-cash-forecast" data={data} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Cash forecast'), 'the tile shell still renders')
    assert.ok(html.includes('no spot rate'), 'the tile shows the refusal instead of failing the dashboard')
  } finally {
    await unmount()
  }
})

test('lowest-point tile refuses by name when the rate is missing', async () => {
  const data = {
    ...lowestData(),
    cashLowest: { available: false, reason: 'no spot rate for EUR→USD on or before 2026-09-16' },
  } as unknown as DashboardMetrics
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-cash-lowest-point" data={data} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('no spot rate'), 'the tile shows the refusal instead of failing the dashboard')
    assert.ok(!html.includes('1,234.56'), 'no figure renders beside the refusal')
  } finally {
    await unmount()
  }
})
