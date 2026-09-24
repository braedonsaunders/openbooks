import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * True Cost hub dashboard (route `/analytics/true-cost`): the spec links the
 * tabular report preserving the query, and the empty-categories guidance
 * names the `burden` dimension.
 */

const { registerHooks } = await import('node:module')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,' }
    }
    return next(specifier, context)
  },
})

const { trueCostSpec } = await import('./view')

function dashboardData(reportHref: string) {
  return {
    title: 'True Cost',
    backLabel: 'Back to hub',
    periodLabel: 'Jul 2026',
    reportHref,
    reportLabel: 'Open report',
    data: {},
  } as unknown as Parameters<typeof trueCostSpec>[0]
}

test('the spec carries an open-report link preserving the query', () => {
  const spec = JSON.stringify(trueCostSpec(dashboardData('/reports/true-cost?period=2026-07')))
  assert.ok(spec.includes('"/analytics/true-cost"'), `the spec must route at /analytics/true-cost, got:\n${spec}`)
  assert.ok(
    spec.includes('"/reports/true-cost?period=2026-07"'),
    `the link button must keep the query, got:\n${spec}`,
  )
  assert.ok(spec.includes('"Open report"'), `the link must carry its label, got:\n${spec}`)
  assert.ok(spec.includes('"true-cost-view"'), `the body must mount the dashboard view, got:\n${spec}`)
  assert.ok(spec.includes('"analytics-header"'), `the header frame must wrap the controls, got:\n${spec}`)
  assert.ok(
    spec.includes('"report-period-filter"'),
    `the header must keep the shared period filter, got:\n${spec}`,
  )
  assert.ok(spec.includes('"link-button"'), `the header must hold the report link, got:\n${spec}`)
})

test('the spec links the bare report route when no query is set', () => {
  const spec = JSON.stringify(trueCostSpec(dashboardData('/reports/true-cost')))
  assert.ok(spec.includes('"/reports/true-cost"'), `the link must target the bare report route, got:\n${spec}`)
  assert.ok(!spec.includes('/reports/true-cost?'), `no stray query may be appended, got:\n${spec}`)
})

test('the open-report copy exists in every locale catalog', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh']) {
    const catalog = JSON.parse(readFileSync(join(process.cwd(), 'web', 'messages', locale, 'analytics.json'), 'utf8')) as {
      trueCost?: { openReport?: unknown }
    }
    assert.equal(typeof catalog.trueCost?.openReport, 'string', `${locale}/analytics.json needs trueCost.openReport`)
    assert.ok((catalog.trueCost?.openReport as string).trim(), `${locale}/analytics.json openReport must not be blank`)
  }
  const en = JSON.parse(readFileSync(join(process.cwd(), 'web', 'messages', 'en', 'analytics.json'), 'utf8')) as {
    trueCost: { openReport: string }
  }
  assert.equal(en.trueCost.openReport, 'Open report')
})

/**
 * F-t09-003: the Categories tab Assign picker is fed by `burden`-dimension
 * account groups, so a group created in any other dimension leaves the
 * picker empty with no explanation. The empty state must name the
 * `burden`-dimension requirement in every locale, or true-cost setup cannot
 * be completed and the composite stays zero.
 */
test('the empty-categories guidance names the burden dimension in every locale', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'ja', 'pt-BR', 'zh']) {
    const catalog = JSON.parse(readFileSync(join(process.cwd(), 'web', 'messages', locale, 'analytics.json'), 'utf8')) as {
      trueCost?: { accountsPanel?: { noCategories?: unknown } }
    }
    const copy = catalog.trueCost?.accountsPanel?.noCategories
    assert.equal(typeof copy, 'string', `${locale}/analytics.json needs trueCost.accountsPanel.noCategories`)
    assert.ok((copy as string).trim(), `${locale}/analytics.json noCategories must not be blank`)
    assert.match(copy as string, /burden/, `${locale}/analytics.json noCategories must name the burden dimension`)
  }
  const en = JSON.parse(readFileSync(join(process.cwd(), 'web', 'messages', 'en', 'analytics.json'), 'utf8')) as {
    trueCost: { accountsPanel: { noCategories: string } }
  }
  assert.equal(
    en.trueCost.accountsPanel.noCategories,
    'No overhead categories yet. Categories are account groups in the `burden` dimension — create one, then assign these accounts to it.',
  )
})
