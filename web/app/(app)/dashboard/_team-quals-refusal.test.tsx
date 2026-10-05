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
