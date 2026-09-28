// source-pin-contract: feature-gate coverage invariant — every page a feature links to and every API route serving it consults a gate; pages derived from the feature and nav registries, route handlers by walking each feature's API directories.
import { NAV_MODULES } from './nav/registry'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readingPagePairs } from './page-source'
import test from 'node:test'
import { FEATURES } from '@openbooks/engine/src/organization/feature-registry.ts'

/** Feature gates are verified per exposed surface, because a gate on one
 * route does not prove that another page or API is protected. */

const WEB = new URL('../', import.meta.url)
const APP_SEGMENT = 'app/(app)'

// The HR-19 document, survey and data-subject-export routes reach their
// feature gate through a shared helper in the segment's own route.ts, the
// same shape as requireFlowsSession and requireProjectsFeature above. Each
// verified to call isFeatureEnabled for HRM AND its module before being
// listed here; a helper that does not gate must never be added.
// A factory route (`defineRoute`) names its feature key and the factory
// answers 404 while that feature is off.
const GATE = /defineRoute\(\{[\s\S]*?\bfeature: (['"])[A-Za-z]+\1|requireFeatureEnabled\(|guardFeaturePermission\(|isFeatureEnabled\(|requireFlowsSession\(|requireProjectsFeature\(|guardProjectsFeature\(|requireProjectSchedulingFeature\(|guardProjectSchedulingFeature\(|guardWipBillingFeature\(|guardPropertyManagementFeature\(|guardSubcontractsFeature\(|guardComplianceFeature\(|guardLienWaiverFeature\(|gateDocuments\(|gateSurveys\(|gateExports\(|meritCycleGate\(/

const read = readingPagePairs((path: string) => readFileSync(new URL(path, WEB), 'utf8'))
const exists = (path: string) => existsSync(new URL(path, WEB))

/** Inspect the same pure registry used by the web and engine gates. */
function featuresWithNav(): Array<{ key: string; navModules: string[] }> {
  const out = FEATURES.flatMap((feature) => feature.navModules
    ? [{ key: feature.key, navModules: feature.navModules }]
    : [])
  assert.ok(out.length > 0, 'feature registry has no navigation entries')
  return out
}

/** nav module key → href, from the nav registry. */
function navHrefs(): Record<string, string> {
  return Object.fromEntries(NAV_MODULES.map((module) => [module.key, module.href]))
}

/** Check the href's page and ancestor layouts for a feature gate; callers
 * report missing page routes separately. */
function routeGateState(href: string): 'gated' | 'ungated' | 'missing' {
  const segments = href.split('?')[0]!.split('/').filter(Boolean)
  let dir = `${APP_SEGMENT}/`
  if (!exists(dir)) return 'missing'
  const candidates: string[] = []
  for (const segment of segments) {
    const next = `${dir}${segment}/`
    if (!exists(next)) return 'missing'
    dir = next
    candidates.push(`${dir}layout.tsx`)
  }
  candidates.push(`${dir}page.tsx`)
  // An ancestor layout gate covers everything beneath it.
  for (const file of candidates) {
    if (exists(file) && GATE.test(read(file))) return 'gated'
  }
  return exists(`${dir}page.tsx`) ? 'ungated' : 'missing'
}

/** API surfaces are listed explicitly because they cannot be derived from nav. */
const FEATURE_API_DIRS: Record<string, string[]> = {
  apps: ['app/api/apps'],
  // app/api/close/run-revaluation is deliberately absent: it already consults
  // the multiCurrency gate (listed there), and the per-file scan below would
  // flag it for not naming continuousClose.
  continuousClose: ['app/api/continuous-close', 'app/api/close/runs', 'app/api/close/posting-periods'],
  equipment: ['app/api/equipment'],
  expenses: ['app/api/expenses'],
  budgets: ['app/api/budgets'],
  projects: [
    'app/api/projects',
    'app/api/labor-rate-cards',
    'app/api/construction',
    'app/api/billing-requests',
    'app/api/project-charges',
    'app/api/rate-book-assignments',
    'app/api/items/[id]/rates',
  ],
  timeTracking: ['app/api/timesheets'],
  payroll: ['app/api/payroll', 'app/api/work-schedules'],
  fixedAssets: ['app/api/assets'],
  inventory: ['app/api/inventory', 'app/api/items/[id]/costing'],
  warehousing: ['app/api/warehouses'],
  fulfillment: ['app/api/picks', 'app/api/shipments'],
  returnAuthorizations: ['app/api/returns'],
  fieldTickets: ['app/api/field-tickets'],
  subscriptionBilling: ['app/api/subscriptions'],
  usageBilling: ['app/api/usage'],
  saasMetrics: ['app/api/metrics'],
  advancedSubscriptions: ['app/api/subscriptions/advanced'],
  revenueRecognition: ['app/api/revenue', 'app/api/items/[id]/fair-values'],
  wipBilling: ['app/api/wip-billing'],
  propertyManagement: ['app/api/property-management'],
  projectScheduling: ['app/api/project-schedule'],
  subcontracts: ['app/api/subcontracts'],
  bankFeeds: [
    'app/api/banking/bank-feeds',
    'app/api/banking/sftp',
  ],
  crm: ['app/api/crm', 'app/api/parties/[id]/activities'],
  hrm: ['app/api/hrm'],
  subcontractorCompliance: ['app/api/compliance'],
  scripts: ['app/api/scripts'],
  onlinePayments: ['app/api/payments/links', 'app/api/admin/setup/payment-providers', 'app/api/pay'],
  queryConsole: ['app/api/query'],
  flows: ['app/api/flows', 'app/api/admin/flows'],
  multiSubsidiary: ['app/api/consolidation'],
  multiCurrency: ['app/api/admin/fx-provider', 'app/api/close/run-revaluation'],
  apiAccess: ['app/api/admin/api-keys'],
  // orders: omitted — /api/estimates|sales-orders|purchase-orders route.ts files
  // are thin re-exports of _order/handlers.ts, which already calls
  // guardFeaturePermission(..., 'orders'). Listing the dirs here would fail
  // the per-file GATE scan on those wrappers.
}

function routeFilesUnder(dir: string): string[] {
  const out: string[] = []
  const walk = (relative: string) => {
    const url = new URL(`${relative}/`, WEB)
    for (const entry of readdirSync(url, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(child)
      else if (entry.name === 'route.ts') out.push(child)
    }
  }
  if (exists(`${dir}/`) && statSync(new URL(`${dir}/`, WEB)).isDirectory()) walk(dir)
  return out
}

/** Features deliberately without a gate of their own, with the reason. */
const UNGATED_BY_DESIGN: Record<string, string> = {
  banking: 'nav grouping only — capabilities gate individually (bankFeeds)',
}

const NAV_ARM_PENDING: Record<string, { pack: string; since: string }> = {
  manufacturing: { pack: 'MF-09', since: '2026-09-27' },
}

test('every route a feature links to is gated by its own page or an ancestor layout', () => {
  const hrefs = navHrefs()
  const ungated: string[] = []
  for (const { key, navModules } of featuresWithNav()) {
    for (const moduleKey of navModules) {
      const href = hrefs[moduleKey]
      if (!href) {
        assert.ok(
          NAV_ARM_PENDING[moduleKey],
          `${key}: nav module "${moduleKey}" is missing; register the nav module or remove it from navModules`,
        )
        continue
      }
      assert.equal(
        NAV_ARM_PENDING[moduleKey],
        undefined,
        `${key}: nav module "${moduleKey}" arm landed — delete ${moduleKey} from NAV_ARM_PENDING`,
      )
      assert.ok(href.startsWith('/'), `${key}: nav module "${moduleKey}" has non-route href "${href}"`)
      if (key in UNGATED_BY_DESIGN) continue
      const state = routeGateState(href)
      assert.notEqual(state, 'missing', `${key}: nav module "${moduleKey}" has no app page for "${href}"`)
      if (state === 'ungated') ungated.push(`${key} → ${href}`)
    }
  }
  assert.deepEqual(
    ungated,
    [],
    'these routes render with the feature off, so "disabled" is cosmetic:\n  ' +
      ungated.join('\n  ') +
      '\nAdd requireFeatureEnabled() to the page, or a layout gate on the segment.',
  )
})

test('every API route serving a feature consults a gate', () => {
  const ungated: string[] = []
  for (const [key, dirs] of Object.entries(FEATURE_API_DIRS)) {
    for (const dir of dirs) {
      const files = routeFilesUnder(dir)
      assert.ok(files.length > 0, `${key}: no route handlers found under ${dir} — stale mapping?`)
      for (const file of files) {
        if (!GATE.test(read(file))) ungated.push(`${key} → ${file}`)
      }
    }
  }
  assert.deepEqual(
    ungated,
    [],
    'these API handlers accept requests with the feature off:\n  ' +
      ungated.join('\n  ') +
      '\nUse guardFeaturePermission(permission, featureKey).',
  )
})
