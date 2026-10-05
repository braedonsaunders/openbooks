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
        href: null, amount: '10000.00', currency: 'EUR',
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
