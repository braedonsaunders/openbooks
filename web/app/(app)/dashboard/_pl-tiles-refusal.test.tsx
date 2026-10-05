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

const REFUSAL =
  'No consolidated exchange rates for USD → CAD in the period ending 2026-07-15. Derive rates from period close first.'

function revenueData(): DashboardMetrics {
  return {
    asOfDate: '',
    baseCurrency: 'CAD',
    revenueMtd: '1000.0000',
    plCurrency: 'EUR',
    plPeriodLabel: '2026-07 to date',
    plUnavailable: null,
  } as unknown as DashboardMetrics
}

// The revenue tile labels the currency the consolidated reader returned and
// the fiscal period it covered — a EUR-scope figure must never render with a
// dollar sign, and the hint must never claim "Month to date".
test('the revenue tile labels the reader currency and the resolved period', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-revenue-mtd" data={revenueData()} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('€'), 'the EUR figure formats in its own currency')
    assert.ok(!html.includes('$'), 'no dollar sign leaks onto a EUR figure')
    assert.ok(html.includes('2026-07 to date'), 'the hint names the resolved fiscal period')
    assert.ok(!html.includes('Month to date'), 'the civil-month label is gone')
  } finally {
    await unmount()
  }
})

// A refused consolidated read names its remedy on the tile — the message the
// loader caught is the entire product of the failing tile.
test('a refused P&L read renders its remedy on the tile', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-revenue-mtd" data={{ ...revenueData(), revenueMtd: null, plCurrency: null, plUnavailable: REFUSAL } as unknown as DashboardMetrics} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('Derive rates'), 'the refusal names the remedy')
    assert.ok(!html.includes('No data'), 'the refusal never reads as an empty month')
  } finally {
    await unmount()
  }
})

// A tile with no currency to label refuses by name — it must never format as
// dollars on a fabricated default.
test('a money tile without a base currency refuses by name', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="kpi-ledger-balance" data={{ asOfDate: '', baseCurrency: null, ledgerSum: '42.00' } as unknown as DashboardMetrics} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('No base currency configured'), 'the tile names the missing currency')
    assert.ok(!html.includes('$42'), 'no dollar figure renders without a currency')
  } finally {
    await unmount()
  }
})
