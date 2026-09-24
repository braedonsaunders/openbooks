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

function entriesData() {
  return {
    recentEntries: [
      {
        id: 'entry-posted-1',
        entryNumber: 'JE-1001',
        postingDate: '2026-08-01',
        memo: 'Manual accrual',
        status: 'posted',
        lineCount: 1,
        totalDebits: '100.00',
      },
      {
        id: 'entry-reversed-2',
        entryNumber: 'JE-1002',
        postingDate: '2026-08-02',
        memo: 'Reversed accrual',
        status: 'reversed',
        lineCount: 3,
        totalDebits: '50.00',
      },
      {
        id: 'entry-draft-3',
        entryNumber: null,
        postingDate: '2026-08-03',
        memo: null,
        status: 'draft',
        lineCount: 1,
        totalDebits: '10.00',
      },
    ],
  } as unknown as DashboardMetrics
}

// Every recent-entry row once showed the English "posted" badge and "N lines"
// count under fr/es while the whole surrounding dashboard was translated. The
// status and the line count must come from the catalog — with the singular
// proving the plural rule runs (a hardcoded "{n} lines" reads "1 lines").
// Unknown statuses render raw rather than guessing a translation. (Was F-t01-009.)
test('recent journal rows render the status and line count from the catalog', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="list-recent-entries" data={entriesData()} />,
    { dashboard: catalog('en') },
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('>Posted<'), 'the posted badge resolves through dashboard.widgets copy')
    assert.ok(!html.includes('>posted<'), 'the raw status code must never render')
    assert.ok(html.includes('>Reversed<'), 'the reversed badge resolves through dashboard.widgets copy')
    assert.ok(html.includes('1 line<'), 'the singular line count runs the catalog plural rule')
    assert.ok(html.includes('3 lines<'), 'the plural line count runs the catalog plural rule')
    assert.ok(html.includes('>draft<'), 'an unknown status renders raw rather than guessed')
  } finally {
    await unmount()
  }
})

test('recent journal rows translate the status and line count in French', async () => {
  const { host, unmount } = await mountDashboard(
    <WidgetCard widgetId="list-recent-entries" data={entriesData()} />,
    { dashboard: catalog('fr') },
    'fr',
  )
  try {
    const html = host.innerHTML
    assert.ok(html.includes('>Comptabilisé<'), 'the posted badge translates')
    assert.ok(!html.includes('>posted<'), 'the raw status code must never render')
    assert.ok(html.includes('>Contre-passé<'), 'the reversed badge translates')
    assert.ok(html.includes('1 ligne<'), 'the singular line count translates')
  } finally {
    await unmount()
  }
})
