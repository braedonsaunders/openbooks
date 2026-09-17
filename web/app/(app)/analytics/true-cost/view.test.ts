import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * True Cost hub dashboard (route `/analytics/true-cost`).
 *
 * The route used to `redirect('/reports/true-cost')` — an analytics
 * dashboard must not redirect to a report page. These pins are source
 * contracts (no module hooks, no top-level await) so they cannot hang a
 * unit shard the way an executed ModuleView import did under
 * `--test-force-exit`.
 */

const pageSource = readFileSync(new URL('./page.tsx', import.meta.url), 'utf8')
const viewSource = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('the dashboard page renders through ModuleView instead of redirecting', () => {
  assert.doesNotMatch(pageSource, /redirect\(/)
  assert.match(pageSource, /ModuleView/)
  assert.match(pageSource, /loadTrueCost/)
  assert.match(pageSource, /trueCostSpec/)
  assert.match(pageSource, /true-cost-view|trusted/)
})

test('the loader requires reports.read', () => {
  assert.match(viewSource, /requirePermission\('reports\.read'\)/)
})

test('the loader requires the projects feature', () => {
  assert.match(viewSource, /requireFeatureEnabled\(authz\.user\.orgId, 'projects'\)/)
})

test('the loader scopes queries to the reader subsidiary fence', () => {
  assert.match(viewSource, /trueCostData\(/)
  assert.match(viewSource, /authz\.allowedSubsidiaryIds/)
})

test('the spec carries an open-report link preserving the query', () => {
  assert.match(viewSource, /reportHref: `\/reports\/true-cost\$\{qs \? `\?\$\{qs\}` : ''\}`/)
  assert.match(viewSource, /route: '\/analytics\/true-cost'/)
  assert.match(viewSource, /widgetBlock\('true-cost-view'/)
  assert.match(viewSource, /frame\(\s*'analytics-header'/)
  assert.match(viewSource, /widgetBlock\('report-period-filter'\)/)
  assert.match(viewSource, /widgetBlock\('link-button'/)
})

test('the spec links the bare report route when no query is set', () => {
  assert.match(viewSource, /\/reports\/true-cost/)
  assert.match(viewSource, /qs \? `\?\$\{qs\}` : ''/)
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
