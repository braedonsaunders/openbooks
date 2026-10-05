import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import './_dashboard-render-harness'
import { mountDashboard } from './_dashboard-render-harness'
import type { DashboardMetrics } from './_metrics'

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
