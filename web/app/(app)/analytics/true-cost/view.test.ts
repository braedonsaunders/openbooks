import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerHooks } from 'node:module'
import test from 'node:test'
import * as React from 'react'

/**
 * True Cost hub dashboard (route `/analytics/true-cost`).
 *
 * The route used to `redirect('/reports/true-cost')` — an analytics
 * dashboard must not redirect to a report page. These tests pin the
 * restored shape: the page renders through ModuleView (no redirect), the
 * loader enforces the same permission + projects gate as its siblings and
 * forwards the reader's subsidiary scope, and the spec composes the family
 * hub widgets plus an "Open report" link that preserves the query.
 */

const PERIOD = { from: '2026-07-01', to: '2026-07-31', label: 'July 2026' }

interface TcTestState {
  permArgs: string[]
  gateArgs: Array<{ orgId: string; key: string }>
  dataArgs: { orgId: string; period: unknown; allowed: unknown } | null
  authzError: string | null
  gateError: string | null
  allowed: Set<string> | null
}

const state: TcTestState = {
  permArgs: [],
  gateArgs: [],
  dataArgs: null,
  authzError: null,
  gateError: null,
  allowed: null,
}
;(globalThis as { __tcState?: TcTestState }).__tcState = state
// page.tsx compiles to the classic JSX runtime, which reads React off the
// global scope under plain node (the same shim the analytics scope tests use).
;(globalThis as { React?: typeof React }).React = React

const PERIOD_STUB = `{ from: ${JSON.stringify(PERIOD.from)}, to: ${JSON.stringify(PERIOD.to)}, label: ${JSON.stringify(PERIOD.label)} }`

const stubs: Record<string, string> = {
  'server-only': 'export {}',
  'next-intl/server': 'export async function getTranslations(){ return (key) => key }',
  '../../../../lib/authz':
    `export async function requirePermission(perm){
       const s = globalThis.__tcState; s.permArgs.push(perm);
       if (s.authzError) throw new Error(s.authzError);
       return { user: { orgId: 'org-123' }, allowedSubsidiaryIds: s.allowed };
     }`,
  '../../../../lib/feature-gates':
    `export async function requireFeatureEnabled(orgId, key){
       const s = globalThis.__tcState; s.gateArgs.push({ orgId, key });
       if (s.gateError) throw new Error(s.gateError);
     }`,
  '../../../../lib/periods': `export async function resolvePeriod(){ return (${PERIOD_STUB}) }`,
  '../../../../lib/analytics/true-cost-data':
    `export async function trueCostData(orgId, period, allowed){
       globalThis.__tcState.dataArgs = { orgId, period, allowed };
       return { marker: 'canned-true-cost' };
     }`,
  // The page is never rendered here — JSX only builds the element, so the
  // test reads the element's props. The stub keeps the heavy widget graph
  // (every widget in the app) out of the import.
  '../../../../components/viewspec/module-view': `export function ModuleView(){ return null }`,
}

registerHooks({
  resolve(specifier, context, next) {
    if (stubs[specifier]) return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(stubs[specifier]) }
    return next(specifier, context)
  },
})

const { loadTrueCost, trueCostSpec } = await import('./view')
const { default: TrueCostPage } = await import('./page')

function reset(overrides: Partial<Pick<TcTestState, 'authzError' | 'gateError' | 'allowed'>> = {}) {
  state.permArgs = []
  state.gateArgs = []
  state.dataArgs = null
  state.authzError = overrides.authzError ?? null
  state.gateError = overrides.gateError ?? null
  state.allowed = 'allowed' in overrides ? (overrides.allowed ?? null) : null
}

const QUERY = { period: '2026-Q3', from: '2026-07-01', to: '2026-09-30' }

interface ModuleViewElement {
  props: { spec: unknown; data: unknown; searchParams: unknown; trusted: unknown }
}

test('the dashboard page renders through ModuleView instead of redirecting', async () => {
  reset()
  // The old page threw NEXT_REDIRECT here; the restored page returns a
  // ModuleView element carrying the dashboard spec.
  const element = (await TrueCostPage({ searchParams: Promise.resolve({ ...QUERY }) })) as unknown as ModuleViewElement
  const props = element.props
  assert.ok(props && typeof props === 'object', 'page must render ModuleView')
  assert.equal(props.trusted, true)
  assert.deepEqual(props.searchParams, QUERY)
  const specJson = JSON.stringify(props.spec)
  assert.ok(specJson.includes('/analytics/true-cost'), 'spec must target the dashboard route')
  assert.ok(specJson.includes('true-cost-view'), 'spec must render the dashboard view widget')
})

test('the loader requires reports.read', async () => {
  reset({ authzError: 'NEXT_REDIRECT;/' })
  await assert.rejects(loadTrueCost({}), /NEXT_REDIRECT/)
  assert.deepEqual(state.permArgs, ['reports.read'])
})

test('the loader requires the projects feature', async () => {
  reset({ gateError: 'NEXT_HTTP_ERROR_FALLBACK;404' })
  await assert.rejects(loadTrueCost({}), /404/)
  assert.deepEqual(state.gateArgs, [{ orgId: 'org-123', key: 'projects' }])
})

test('the loader scopes queries to the reader subsidiary fence', async () => {
  const allowed = new Set(['sub-1'])
  reset({ allowed })
  const data = await loadTrueCost({})
  assert.ok(state.dataArgs, 'loader must query true-cost data')
  assert.equal(state.dataArgs.orgId, 'org-123')
  assert.deepEqual(state.dataArgs.period, PERIOD)
  assert.equal(state.dataArgs.allowed, allowed, 'the exact subsidiary fence must reach the query, not null')
  assert.ok(data.data, 'loader must return the data for the spec')
})

test('the spec carries an open-report link preserving the query', async () => {
  reset()
  const data = await loadTrueCost({ ...QUERY })
  assert.equal(
    data.reportHref,
    '/reports/true-cost?period=2026-Q3&from=2026-07-01&to=2026-09-30',
    'the report link must preserve the dashboard query',
  )
  assert.equal(data.reportLabel, 'openReport', 'the label must resolve through translations, not a literal')
  const specJson = JSON.stringify(trueCostSpec(data))
  assert.ok(specJson.includes('analytics-header'), 'spec must use the family header frame')
  assert.ok(specJson.includes('report-period-filter'), 'spec must carry the period filter bar')
  assert.ok(specJson.includes('link-button'), 'spec must render the report link through the link-button widget')
  assert.ok(specJson.includes(data.reportHref), 'the exact report href must reach the rendered spec')
  assert.ok(specJson.includes('canned-true-cost'), 'the loaded data must reach the dashboard widget')
})

test('the spec links the bare report route when no query is set', async () => {
  reset()
  const data = await loadTrueCost({})
  assert.equal(data.reportHref, '/reports/true-cost')
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
