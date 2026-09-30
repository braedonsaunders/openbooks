import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
const { trueCostSpec } = await import('./view')

test('the report links to the analytics dashboard that holds the planning', () => {
  const spec = JSON.stringify(
    trueCostSpec({
      plannerHref: '/analytics/true-cost?period=2026-07',
      plannerLabel: 'Open analytics',
    } as unknown as Parameters<typeof trueCostSpec>[0]),
  )
  assert.ok(
    spec.includes('"/analytics/true-cost?period=2026-07"'),
    `the report action targets the dashboard, never a separate planner route, got:\n${spec}`,
  )
  assert.ok(spec.includes('"Open analytics"'), `the label names the page it really is, got:\n${spec}`)
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
