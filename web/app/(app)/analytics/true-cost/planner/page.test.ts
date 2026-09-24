import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * The former true-cost planner route rendered the same read-only dashboard
 * as /analytics/true-cost, whose absorption and selling tabs already carry
 * the interactive recovery planning. The route redirects to that dashboard
 * (keeping the query) and owns no view of its own; the report links to the
 * dashboard that holds the planning.
 */

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export function redirect(url){throw new Error(`NEXT_REDIRECT;replace;${url};307`)}',
      }
    }
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,' }
    }
    return next(specifier, context)
  },
})

const { default: TrueCostPlannerPage } = await import('./page')
const { trueCostSpec } = await import('../../../reports/true-cost/view')

async function redirectTarget(searchParams: Record<string, string | undefined>): Promise<string> {
  try {
    await TrueCostPlannerPage({ searchParams: Promise.resolve(searchParams) })
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('the planner route must redirect, never render')
}

test('the planner route redirects to the dashboard keeping the query', async () => {
  const target = await redirectTarget({ period: '2026-07', segment: 'retail' })
  assert.ok(
    target.includes('/analytics/true-cost?period=2026-07&segment=retail'),
    `the redirect must keep the query, got: ${target}`,
  )
})

test('the planner route redirects bare when no query is set', async () => {
  const target = await redirectTarget({})
  assert.ok(
    target.includes('/analytics/true-cost') && !target.includes('/analytics/true-cost?'),
    `the redirect must land on the bare dashboard, got: ${target}`,
  )
})

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
