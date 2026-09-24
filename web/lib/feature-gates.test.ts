import { NAV_MODULES } from './nav/registry'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readingPagePairs } from './page-source'
import test from 'node:test'
import { FEATURES } from '@openbooks/engine/src/organization/feature-registry.ts'

/**
 * The feature registry states a contract: "a feature that's off disappears from
 * nav, its routes 404, and its setup surfaces hide." Feature dependencies are
 * enforced at the domain/service and API boundaries, not only by hiding UI.
 *
 * An earlier version of this test asked only whether a feature key appeared in
 * SOME gate call anywhere under web/. That is far too weak, and it produced
 * exactly the false confidence it was written to prevent: `apps` counted as
 * gated because /apps had a layout gate, while /admin/apps and all nine
 * /api/apps routes stayed permission-only. A test that reports "gated" for an
 * ungated surface is worse than no test.
 *
 * So coverage is checked PER SURFACE:
 *   - every route a feature's nav modules link to must be gated by its own
 *     page/layout or by an ancestor layout inside the (app) segment;
 *   - every API route handler serving a feature must consult a gate.
 */

const WEB = new URL('../', import.meta.url)
const APP_SEGMENT = 'app/(app)'

// The HR-19 document, survey and data-subject-export routes reach their
// feature gate through a shared helper in the segment's own route.ts, the
// same shape as requireFlowsSession and requireProjectsFeature above. Each
// verified to call isFeatureEnabled for its module AND its sub-switch before
// being listed here; a helper that does not gate must never be added.
const GATE = /requireFeatureEnabled\(|guardFeaturePermission\(|isFeatureEnabled\(|requireFlowsSession\(|requireProjectsFeature\(|guardProjectsFeature\(|requireProjectSchedulingFeature\(|guardProjectSchedulingFeature\(|guardWipBillingFeature\(|guardPropertyManagementFeature\(|guardSubcontractsFeature\(|guardComplianceFeature\(|guardLienWaiverFeature\(|gateDocuments\(|gateSurveys\(|gateExports\(/

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

/**
 * Is the route this href resolves to gated — by its own page/layout, or by any
 * ancestor layout still inside the (app) segment? Returns null when the href
 * has no directory (external or dynamic), which the caller reports separately.
 */
function routeGateState(href: string): 'gated' | 'ungated' | null {
  const segments = href.split('?')[0]!.split('/').filter(Boolean)
  let dir = `${APP_SEGMENT}/`
  if (!exists(dir)) return null
  const candidates: string[] = []
  for (const segment of segments) {
    const next = `${dir}${segment}/`
    if (!exists(next)) return null
    dir = next
    candidates.push(`${dir}layout.tsx`)
  }
  candidates.push(`${dir}page.tsx`)
  // An ancestor layout gate covers everything beneath it.
  for (const file of candidates) {
    if (exists(file) && GATE.test(read(file))) return 'gated'
  }
  return exists(`${dir}page.tsx`) ? 'ungated' : null
}

/**
 * API surfaces per feature. Not derivable from nav, so it is explicit — and
 * being explicit is the point: adding a module's API without listing it here is
 * the omission that let /api/apps ship ungated.
 */
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
  fieldTickets: ['app/api/field-tickets'],
  subscriptionBilling: ['app/api/subscriptions'],
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

test('every route a feature links to is gated by its own page or an ancestor layout', () => {
  const hrefs = navHrefs()
  const ungated: string[] = []
  for (const { key, navModules } of featuresWithNav()) {
    if (key in UNGATED_BY_DESIGN) continue
    for (const moduleKey of navModules) {
      const href = hrefs[moduleKey]
      if (!href || !href.startsWith('/')) continue
      if (routeGateState(href) === 'ungated') ungated.push(`${key} → ${href}`)
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
