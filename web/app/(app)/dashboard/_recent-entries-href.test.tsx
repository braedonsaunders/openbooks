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
const dashboardEn = JSON.parse(
  readFileSync(join(dir, '..', '..', '..', 'messages', 'en', 'dashboard.json'), 'utf8'),
);

// Posted entry identifiers open the shared journal-entry drawer directly.
test('recent journal entries open the shared journal-entry drawer', async () => {
  const data = {
    recentEntries: [
      {
        id: 'entry-posted-1',
        entryNumber: 'JE-1001',
        postingDate: '2026-08-01',
        memo: 'Manual accrual',
        status: 'posted',
        lineCount: 2,
        totalDebits: '100.00',
      },
      {
        id: 'entry-subledger-9',
        entryNumber: 'BILL-42',
        postingDate: '2026-08-02',
        memo: 'Vendor bill posting',
        status: 'posted',
        lineCount: 4,
        totalDebits: '250.00',
      },
    ],
  } as unknown as DashboardMetrics
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="list-recent-entries" data={data} />,
    { dashboard: dashboardEn },
  )
  try {
    const rowHrefs = [...host.querySelectorAll('li a')].map((a) => a.getAttribute('href'))
    assert.deepEqual(rowHrefs, ['/journal?journalEntry=entry-posted-1', '/journal?journalEntry=entry-subledger-9'])
    assert.ok(
      rowHrefs.every((href) => !href?.includes('?entry=')),
      'no row may link through the manual-journal drawer param',
    )
  } finally {
    await unmount()
  }
})
