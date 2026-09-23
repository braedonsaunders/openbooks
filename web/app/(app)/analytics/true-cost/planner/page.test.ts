import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * The former true-cost planner route promised modelling it never owned:
 * it rendered the same read-only dashboard as /analytics/true-cost, whose
 * absorption and selling tabs already carry the interactive recovery
 * planning. The route redirects to that dashboard (keeping the query) and
 * owns no view of its own, so nothing can promise a separate planner
 * again; the report links to the dashboard that holds the planning.
 */

const pageSource = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')

test('the planner route redirects to the dashboard keeping the query', () => {
  assert.match(pageSource, /redirect\(`\/analytics\/true-cost\$\{qs \? `\?\$\{qs\}` : ''\}`\)/)
  assert.ok(!pageSource.includes('./view'), 'the redirect owns no view to drift from the dashboard')
  assert.ok(!pageSource.includes('loadTrueCostPlanner'), 'the duplicate loader is gone')
})

test('the report links to the analytics dashboard that holds the planning', () => {
  const viewSource = readFileSync(
    new URL('../../../reports/true-cost/view.ts', import.meta.url),
    'utf8',
  )
  assert.match(
    viewSource,
    /plannerHref: `\/analytics\/true-cost\$\{dashboardQs \? `\?\$\{dashboardQs\}` : ''\}`/,
    'the report action targets the dashboard, never a separate planner route',
  )
  assert.match(viewSource, /plannerLabel: tc\('openAnalytics'\)/, 'the label names the page it really is')
  assert.match(
    viewSource,
    /the True Cost analytics dashboard/,
    'the header documents where the planning lives',
  )
})

test('the open-analytics copy exists in every locale catalog', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh']) {
    const catalog = JSON.parse(
      readFileSync(join(process.cwd(), 'web', 'messages', locale, 'analytics.json'), 'utf8'),
    ) as { trueCost?: { openAnalytics?: unknown } }
    assert.equal(
      typeof catalog.trueCost?.openAnalytics,
      'string',
      `${locale}/analytics.json needs trueCost.openAnalytics`,
    )
    assert.ok(
      (catalog.trueCost?.openAnalytics as string).trim(),
      `${locale}/analytics.json openAnalytics must not be blank`,
    )
  }
})
