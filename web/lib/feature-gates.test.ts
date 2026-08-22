import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import test from 'node:test'

/**
 * The feature registry states a contract: "a feature that's off disappears from
 * nav, its routes 404, and its setup surfaces hide." AGENTS.md restates it as a
 * rule — feature dependencies are enforced at the domain/service and API
 * boundaries, "not only by hiding UI".
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

const GATE = /requireFeatureEnabled\(|guardFeaturePermission\(|isFeatureEnabled\(|requireProjectsFeature\(|guardProjectsFeature\(|requireProjectSchedulingFeature\(|guardProjectSchedulingFeature\(|guardWipBillingFeature\(|guardPropertyManagementFeature\(|guardSubcontractsFeature\(|guardComplianceFeature\(|guardLienWaiverFeature\(/

const read = (path: string) => readFileSync(new URL(path, WEB), 'utf8')
const exists = (path: string) => existsSync(new URL(path, WEB))

/** The feature registry, parsed from source (`features.ts` is server-only). */
function featuresWithNav(): Array<{ key: string; navModules: string[] }> {
  const source = read('lib/features.ts')
  const list = source.slice(
    source.indexOf('export const FEATURES'),
    source.indexOf('\n]', source.indexOf('export const FEATURES')),
  )
  const out: Array<{ key: string; navModules: string[] }> = []
  for (const entry of list.matchAll(/\{ key: '(\w+)'[^}]*\}/g)) {
    const nav = /navModules: \[([^\]]*)\]/.exec(entry[0])
    if (!nav) continue
    out.push({ key: entry[1], navModules: [...nav[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1]) })
  }
  assert.ok(out.length > 0, 'could not parse the feature registry')
  return out
}

/** nav module key → href, from the nav registry. */
function navHrefs(): Record<string, string> {
  const source = read('lib/nav/registry.ts')
  return Object.fromEntries(
    [...source.matchAll(/key: '([\w-]+)',\s*\n\s*href: '([^']+)'/g)].map((m) => [m[1], m[2]]),
  )
}

/**
 * Is the route this href resolves to gated — by its own page/layout, or by any
 * ancestor layout still inside the (app) segment? Returns null when the href
 * has no directory (external or dynamic), which the caller reports separately.
 */
function routeGateState(href: string): 'gated' | 'ungated' | null {
  const segments = href.split('?')[0].split('/').filter(Boolean)
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
  continuousClose: ['app/api/continuous-close'],
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
  ],
  timeTracking: ['app/api/timesheets'],
  payroll: ['app/api/payroll', 'app/api/work-schedules'],
  fixedAssets: ['app/api/assets'],
  inventory: ['app/api/inventory'],
  fieldTickets: ['app/api/field-tickets'],
  subscriptionBilling: ['app/api/subscriptions'],
  advancedSubscriptions: ['app/api/subscriptions/advanced'],
  revenueRecognition: ['app/api/revenue'],
  wipBilling: ['app/api/wip-billing'],
  propertyManagement: ['app/api/property-management'],
  projectScheduling: ['app/api/project-schedule'],
  subcontracts: ['app/api/subcontracts'],
  bankFeeds: ['app/api/banking/bank-feeds'],
  crm: ['app/api/crm'],
  subcontractorCompliance: ['app/api/compliance'],
  scripts: ['app/api/scripts'],
  onlinePayments: ['app/api/payments/links', 'app/api/admin/setup/payment-providers'],
  queryConsole: ['app/api/query'],
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

test('the surfaces this test was written for are covered', () => {
  // Pinned by name so a future refactor of the scans above cannot quietly stop
  // covering the cases that motivated them.
  assert.equal(routeGateState('/admin/apps'), 'gated')
  assert.equal(routeGateState('/apps'), 'gated')
  assert.equal(routeGateState('/continuous-close'), 'gated')
  assert.equal(routeGateState('/expenses/reports'), 'gated')
  for (const file of routeFilesUnder('app/api/apps')) {
    assert.match(read(file), GATE, `${file} lost its feature gate`)
  }
  assert.match(
    read('app/api/revenue/run-recognition/route.ts'),
    /isFeatureEnabled\(user\.orgId, 'revenueRecognition'\)/,
    'recognition posting must refuse when the revenue recognition gate is off',
  )
})

test('the report catalog page filters entities the reader cannot run', () => {
  // The list exposes names, slugs and the stored PLAN, and the counts expose
  // how many exist. Both are disclosures; both are filtered.
  const page = read('app/(app)/reports/custom/page.tsx')
  assert.match(page, /requiredPermission && !can\(authz/)
  assert.match(page, /const visible =/)
  const countsQuery = page.slice(page.indexOf('select kind, count(*)'))
  assert.match(
    countsQuery.slice(0, 200),
    /\$\{visible\}/,
    'the kind counts must apply the same entity filter as the list',
  )
})
