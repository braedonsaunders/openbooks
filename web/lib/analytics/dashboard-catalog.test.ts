import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test, { mock } from 'node:test'
import pg from 'pg'
import React, { isValidElement, type ReactElement } from 'react'
import { widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import { stubModules } from '../../testing/stub-modules'
import { statementReportSpec } from '../reports/statement-report-spec'
import { ANALYTICS_DASHBOARDS, ANALYTICS_DASHBOARD_MAP, ANALYTICS_GROUPS } from './dashboard-catalog'

Object.assign(globalThis, { React })

const stateKey = Symbol.for('openbooks.analytics-catalog-page-test')
const state = {
  data: Object.fromEntries(ANALYTICS_DASHBOARDS.map(({ slug }) => [slug, {
    sourceSlug: slug,
    weeks: [],
    rows: [],
    asOf: '2026-07-31',
  }])),
}
Object.assign(globalThis, { [stateKey]: state })

stubModules({ navigation: true })
const refuseDatabaseAccess = () => { throw new Error('Unexpected database read in analytics page composition') }
mock.method(pg.Pool.prototype, 'query', refuseDatabaseAccess)
mock.method(pg.Pool.prototype, 'connect', refuseDatabaseAccess)

// Page composition runs with the actual loaders and spec builders. Only
// database-backed analytics reads and request services are isolated here.
const dataReads: Record<string, { slug: string; exports: string[] }> = {
  'receivables-data': { slug: 'receivables-intelligence', exports: ['receivablesData'] },
  'receivables-intelligence-data': { slug: 'receivables-intelligence', exports: ['receivablesIntelligenceData'] },
  'health-data': { slug: 'financial-health', exports: ['healthData', 'healthSummaryData'] },
  'cashflow-data': { slug: 'cashflow', exports: ['cashflowData'] },
  'true-cost-data': { slug: 'true-cost', exports: ['trueCostData'] },
  'utilization-data': { slug: 'utilization', exports: ['utilizationData'] },
  'customer-data': { slug: 'customer-intelligence', exports: ['customerData', 'customerSummaryData', 'customerProfitability'] },
  'vendor-data': { slug: 'vendor-performance', exports: ['vendorData'] },
  'spend-velocity-data': { slug: 'spend-velocity', exports: ['spendVelocityData'] },
  'sentinel-data': { slug: 'sentinel', exports: ['sentinelData'] },
}
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if ((context.parentURL?.includes('/app/(app)/analytics/') && context.parentURL.endsWith('/view.ts')) || context.parentURL?.endsWith('/lib/analytics/dashboard-reader.ts') || context.parentURL?.endsWith('/lib/analytics/dashboard-access.ts') || context.parentURL?.endsWith('/lib/analytics/preview-cache.ts')) {
      if (specifier.endsWith('/lib/authz') || specifier === '../authz') {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,' + encodeURIComponent(`
            export { can, ForbiddenError } from ${JSON.stringify(new URL('../authz.ts', import.meta.url).href)};
            export async function requirePermission() {
              return {
                user: { orgId: 'org', id: 'user' },
                permissions: new Set(['ar.read', 'ap.read', 'gl.read', 'banking.read', 'projects.read', 'time.read', 'reports.read', 'admin.audit.read', 'admin.setup.manage']),
                allowedSubsidiaryIds: null,
              };
            }
          `),
        }
      }
      if (specifier.endsWith('/lib/features') || specifier.endsWith('/lib/feature-gates') || specifier === '../features' || specifier === '../feature-gates') {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,' + encodeURIComponent(`
            export async function isFeatureEnabled(_orgId, key) { return ['projects', 'timeTracking', 'budgets'].includes(key); }
            export async function requireFeatureEnabled(orgId, key) {
              if (!await isFeatureEnabled(orgId, key)) throw new Error('Feature disabled: ' + key);
            }
          `),
        }
      }
      // Organization configuration and the presentation currency are
      // database reads; the composition under test only needs their values.
      if (specifier.endsWith('/lib/analytics/config')) {
        return { shortCircuit: true, url: 'data:text/javascript,export async function analyticsConfig(){return {}}' }
      }
      if (specifier.endsWith('/lib/fx-presentation')) {
        return { shortCircuit: true, url: 'data:text/javascript,export async function presentationCurrency(){return "USD"}' }
      }
      if (specifier === '@openbooks/engine/platform/business-date') return { shortCircuit: true, url: 'data:text/javascript,export async function businessToday(){return "2026-07-31"}' }
      if (specifier === 'next-intl/server') {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,' + encodeURIComponent(`
            export async function getTranslations() { return (key) => key; }
            export async function getLocale() { return 'en'; }
          `),
        }
      }
      if (specifier.endsWith('/lib/periods')) {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,' + encodeURIComponent(`
            export async function resolvePeriod() {
              return { presetId: 'custom', from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026' };
            }
          `),
        }
      }
      const read = dataReads[specifier.split('/').at(-1)!]
      if (read && specifier.includes('/lib/analytics/')) {
        return {
          shortCircuit: true,
          url: 'data:text/javascript,' + encodeURIComponent(read.exports.map((name) => `
            export async function ${name}() {
              return globalThis[Symbol.for('openbooks.analytics-catalog-page-test')].data[${JSON.stringify(read.slug)}];
            }
          `).join('\n')),
        }
      }
    }
    if (specifier === './connection' && context.parentURL?.endsWith('/jobs/src/read-cache.ts')) return { shortCircuit: true, url: 'data:text/javascript,export async function getReadCacheConnection(){return undefined}' }
    return next(specifier, context)
  },
})
const { ModuleView } = await import('../../components/viewspec/module-view')
test.after(() => {
  hooks.deregister()
  mock.restoreAll()
  Reflect.deleteProperty(globalThis, stateKey)
})

interface DashboardPageProps {
  spec: PageSpec
  data: { data: { sourceSlug: string } }
  searchParams: Record<string, string | undefined>
  trusted: boolean
}

const nativeWidgets: Record<string, string> = {
  'receivables-intelligence': 'receivables-view',
  'financial-health': 'financial-health-view',
  cashflow: 'cashflow-view',
  'true-cost': 'true-cost-view',
  utilization: 'utilization-view',
  'customer-intelligence': 'customer-view',
  'vendor-performance': 'vendor-view',
  'spend-velocity': 'spend-velocity-view',
  sentinel: 'sentinel-view',
}

function assertNativeDashboard(slug: string, result: unknown): asserts result is ReactElement<DashboardPageProps> {
  assert.ok(isValidElement<DashboardPageProps>(result), `${slug}: the dashboard page must return a rendered view`)
  assert.equal(result.type, ModuleView, `${slug}: the dashboard must use the native page renderer`)
  assert.equal(result.props.spec.route, `/analytics/${slug}`, `${slug}: the page must own its analytics route`)
  assert.deepEqual(
    result.props.spec.body.map((block) => block.kind === 'widget' ? block.widget : block.kind),
    [nativeWidgets[slug]],
    `${slug}: the page must render its native dashboard body; report paper and report widgets belong in Reports`,
  )
}

test('analytics catalog entries declare unique native routes and dashboard metadata', () => {
  assert.equal(new Set(ANALYTICS_DASHBOARDS.map((dashboard) => dashboard.slug)).size, ANALYTICS_DASHBOARDS.length)
  for (const dashboard of ANALYTICS_DASHBOARDS) {
    assert.equal(ANALYTICS_DASHBOARD_MAP[dashboard.slug], dashboard)
    assert.ok(ANALYTICS_GROUPS.includes(dashboard.group), dashboard.slug)
    assert.ok(dashboard.titleKey, `${dashboard.slug}: dashboard copy must be declared`)
    assert.equal('reportSlug' in dashboard, false, `${dashboard.slug}: reports belong in the Reports catalog`)
    assert.equal('reportHref' in dashboard, false, `${dashboard.slug}: report redirects are not dashboards`)
  }
})

test('every analytics entry executes its dedicated page and renders a native dashboard rather than a report shortcut', async (t) => {
  for (const dashboard of ANALYTICS_DASHBOARDS) {
    await t.test(dashboard.slug, async () => {
      assert.ok(nativeWidgets[dashboard.slug], `${dashboard.slug}: declare the native dashboard body contract`)
      const { default: DashboardPage } = await import(new URL(`../../app/(app)/analytics/${dashboard.slug}/page.tsx`, import.meta.url).href)
      const search = { period: 'custom', from: '2026-07-01', to: '2026-07-31', horizon: '4' }
      const result = await DashboardPage({ searchParams: Promise.resolve(search) })
      assertNativeDashboard(dashboard.slug, result)
      assert.equal(result.props.data.data.sourceSlug, dashboard.slug, `${dashboard.slug}: the native loader must supply the dashboard data`)
      const body = result.props.spec.body[0]
      assert.ok(body?.kind === 'widget')
      assert.equal(body.when, undefined, `${dashboard.slug}: the dashboard body must be visible`)
      assert.equal(body.props?.data, result.props.data.data, `${dashboard.slug}: the dashboard must receive its loader data`)
      assert.deepEqual(result.props.searchParams, search)
      assert.equal(result.props.trusted, true)
    })
  }
})

test('a report widget cannot pass as a dashboard even when it declares an analytics route', () => {
  const result = React.createElement(ModuleView, {
    spec: statementReportSpec({
      route: '/analytics/financial-health',
      header: { title: 'Profit and Loss' },
      paper: { title: 'Profit and Loss' },
      blocks: [widgetBlock('statement-matrix')],
    }),
    data: {},
    searchParams: {},
    trusted: true,
  })
  assert.throws(() => assertNativeDashboard('financial-health', result), /financial-health:.*report paper and report widgets belong in Reports/)
})

test('industry recommendations retain native capability gates and unrestricted controls', () => {
  assert.equal(ANALYTICS_DASHBOARD_MAP['utilization']?.feature, 'timeTracking')
  assert.equal(ANALYTICS_DASHBOARD_MAP['true-cost']?.feature, 'projects')
  assert.equal(ANALYTICS_DASHBOARD_MAP['sentinel']?.unrestricted, true)
  assert.deepEqual(ANALYTICS_DASHBOARD_MAP['financial-health']?.industries, [])
  assert.ok(ANALYTICS_DASHBOARD_MAP['utilization']?.industries.includes('professional_services'))
})
