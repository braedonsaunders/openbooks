import assert from 'node:assert/strict'
import test from 'node:test'
import './_dashboard-render-harness'
import { mountDashboard } from './_dashboard-render-harness'
import type { DashboardMetrics } from './_metrics'

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims.
const { WidgetCard } = await import('./_widget-views')

const messages = (await import('../../../messages/en')).default as unknown as Record<string, unknown>;

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
    messages,
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
    messages,
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
    messages,
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('No base currency configured'), 'the tile names the missing currency')
    assert.ok(!html.includes('$42'), 'no dollar figure renders without a currency')
  } finally {
    await unmount()
  }
})

// Document totals travel in transaction currency and journal debits in the
// entry subsidiary's functional currency — a EUR 10,000 bill must never
// read as $10,000. Each list formats its row in the row's own currency.
test('record lists format each row in its own currency', async () => {
  const data = {
    asOfDate: '',
    baseCurrency: 'USD',
    recentEntries: [
      {
        id: 'entry-eur-1', entryNumber: 'JE-2001', postingDate: '2026-08-01',
        memo: 'Munich accrual', status: 'posted', lineCount: 2,
        totalDebits: '10000.00', currency: 'EUR',
      },
    ],
    draftDocuments: [
      {
        id: 'draft-eur-1', kind: 'vendor_bill', documentNumber: 'DRAFT-1',
        documentDate: '2026-08-02', total: '10000.00', currency: 'EUR', status: 'draft',
      },
    ],
    pendingApprovalList: [
      {
        id: 'approval-eur-1', targetKind: 'vendor_bill', targetId: 'draft-eur-1',
        href: null, amount: '100.00', currency: 'EUR',
        title: 'VB-EUR', createdAt: '2026-08-02T12:00:00.000Z',
      },
    ],
  } as unknown as DashboardMetrics
  for (const widgetId of ['list-recent-entries', 'personal-in-progress', 'list-pending-approvals'] as const) {
    const { host, unmount } = await mountDashboard(
      <WidgetCard widgetId={widgetId} data={data} />,
      messages,
    )
    try {
      const html = host.innerHTML
      assert.ok(html.includes('€'), `${widgetId}: the EUR row formats in its own currency`)
      assert.ok(!html.includes('$10,000.00'), `${widgetId}: no dollar figure leaks onto a EUR row`)
    } finally {
      await unmount()
    }
  }
})

// Until the qualification source exists the tile refuses by name — it must
// never assert "No expiring qualifications" without reading anything.
test('the team-quals tile is unavailable by name until its source exists', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="team-quals" data={{ teamQuals: null } as unknown as DashboardMetrics} />,
    messages,
  )
  try {
    assert.ok(host.innerHTML.includes('Unavailable'), 'the tile names its unavailable state')
    assert.ok(!host.innerHTML.includes('No expiring qualifications'), 'no false all-clear without a source')
  } finally {
    await unmount()
  }
})

test('the team-quals tile reports an honest empty once its source reads', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="team-quals" data={{ teamQuals: [] } as unknown as DashboardMetrics} />,
    messages,
  )
  try {
    assert.ok(host.innerHTML.includes('No expiring qualifications'), 'an empty roster honestly reports none')
  } finally {
    await unmount()
  }
})
