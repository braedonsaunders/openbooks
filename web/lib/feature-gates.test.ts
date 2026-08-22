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

const GATE = /requireFeatureEnabled\(|guardFeaturePermission\(|isFeatureEnabled\(|requireFlowsSession\(|requireProjectsFeature\(|guardProjectsFeature\(|requireProjectSchedulingFeature\(|guardProjectSchedulingFeature\(|guardWipBillingFeature\(|guardPropertyManagementFeature\(|guardSubcontractsFeature\(|guardComplianceFeature\(|guardLienWaiverFeature\(/

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
  bankFeeds: ['app/api/banking/bank-feeds'],
  crm: ['app/api/crm'],
  subcontractorCompliance: ['app/api/compliance'],
  scripts: ['app/api/scripts'],
  onlinePayments: ['app/api/payments/links', 'app/api/admin/setup/payment-providers'],
  queryConsole: ['app/api/query'],
  flows: ['app/api/flows', 'app/api/admin/flows'],
  multiSubsidiary: ['app/api/consolidation'],
  multiCurrency: ['app/api/admin/fx-provider', 'app/api/close/run-revaluation'],
  apiAccess: ['app/api/admin/api-keys'],
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
  assert.equal(routeGateState('/reports/budget'), 'gated')
  assert.equal(routeGateState('/reports/orders'), 'gated')
  assert.match(
    read('lib/report-run.ts'),
    /STATEMENT_KIND_FEATURE\[kind\]/,
    'statement resolve must refuse budget and project-profitability when their Features switch is off',
  )
  assert.match(
    read('lib/report-authz.ts'),
    /budget: 'budgets'/,
    'budget statement kind must follow the Budgets switch',
  )
  assert.match(
    read('lib/report-authz.ts'),
    /'project-profitability': 'projects'/,
    'project-profitability statement kind must follow the Projects switch',
  )
  assert.match(
    read('lib/report-authz.ts'),
    /REPORT_ENTITY_MAP\[entity\]\?\.featureKey/,
    'query-report entities must consult the catalog featureKey',
  )
  assert.match(
    read('app/api/reports/drill/route.ts'),
    /target\.kind === 'budget' && !\(await isFeatureEnabled/,
    'budget drill must refuse when the Budgets switch is off',
  )
  assert.match(
    read('app/api/reports/drill/route.ts'),
    /target\.kind === 'time' && !\(await isFeatureEnabled/,
    'time drill must refuse when Time Tracking is off',
  )
  assert.match(
    read('app/api/reports/drill/route.ts'),
    /target\.kind === 'orders' && !\(await isFeatureEnabled/,
    'orders drill must refuse when Orders is off',
  )
  assert.match(
    read('lib/setup/registry.ts'),
    /key: 'item-rate-books'[\s\S]{0,400}featureKey: 'projects'/,
    'item rate books are labor pricing and must follow the Projects parent gate',
  )
  assert.match(
    read('lib/setup/registry.ts'),
    /key: 'item-rate-book-assignments'[\s\S]{0,400}featureKey: 'projects'/,
    'item rate-book assignments are labor pricing and must follow the Projects parent gate',
  )
  for (const file of [
    'app/api/documents/[id]/route.ts',
    'app/api/documents/[id]/void/route.ts',
    'app/api/documents/[id]/correct/route.ts',
    'app/api/documents/actions/route.ts',
    'app/api/documents/draft/route.ts',
    'app/api/crm/opportunities/[id]/estimate/route.ts',
    'app/api/parties/[id]/transactions/route.ts',
    'lib/application/documents.ts',
    'lib/api/writers.ts',
    'lib/assistant/tools.ts',
    'lib/crm.ts',
  ]) {
    assert.match(read(file), /isDocKindEnabled\(/, `${file} must refuse optional-module kinds when the feature is off`)
  }
  assert.match(
    read('app/api/crm/opportunities/[id]/estimate/route.ts'),
    /isDocKindEnabled\([^,]+, 'quote'\)/,
    'CRM estimate must refuse when Orders is off',
  )
  assert.match(
    read('app/api/crm/opportunities/[id]/estimate/route.ts'),
    /status: 404/,
    'CRM estimate must 404 — not mint a quote — when Orders is off',
  )
  assert.match(read('lib/api/registry-data.ts'), /featureKey: "projects"/)
  assert.match(read('lib/api/registry-data.ts'), /featureKey: "fixedAssets"/)
  assert.match(
    read('lib/api/schema-registry.ts'),
    /builtIn\.featureKey && !\(await isFeatureEnabled/,
    'REST/MCP catalog must hide projects and assets when their Features switch is off',
  )
  assert.match(
    read('lib/application/approvals.ts'),
    /isFeatureEnabled\(context\.authz\.user\.orgId, "flows"\)/,
    'MCP/assistant approvals must disappear when Flows is off',
  )
  assert.match(
    read('lib/assistant/tools.ts'),
    /isFeatureEnabled\(authz\.user\.orgId, "budgets"\)/,
    'budget_vs_actual must refuse when Budgets is off',
  )
  assert.match(
    read('lib/assistant/tools.ts'),
    /isFeatureEnabled\(authz\.user\.orgId, "continuousClose"\)/,
    'continuous-close findings must refuse when Continuous Close is off',
  )
  assert.match(
    read('lib/assistant/tools-reports.ts'),
    /isFeatureEnabled\(authz\.user\.orgId, "budgets"\)/,
    'budget scenario tools must refuse when Budgets is off',
  )
  assert.match(
    read('lib/assistant/tools-reports.ts'),
    /canRunReportEntity/,
    'list_report_definitions / run_report must hide optional-module plans when the feature is off',
  )
  assert.match(
    read('lib/assistant/tools-analytics.ts'),
    /isFeatureEnabled\(authz\.user\.orgId, "projects"\)/,
    'true-cost must refuse when Projects is off',
  )
  assert.match(
    read('lib/assistant/tools-analytics.ts'),
    /isFeatureEnabled\(authz\.user\.orgId, "timeTracking"\)/,
    'utilization must refuse when Time Tracking is off',
  )
  assert.match(
    read('lib/assistant/tools-analytics.ts'),
    /isFeatureEnabled\(authz\.user\.orgId, "budgets"\)/,
    'financial health must omit budget variance when Budgets is off',
  )
  assert.match(
    read('lib/assistant/tools-analytics.ts'),
    /const projectsOn = await isFeatureEnabled\(orgId, "projects"\)/,
    'customer intelligence must omit job-costed profitability when Projects is off',
  )
  assert.match(
    read('lib/assistant/tools-payroll.ts'),
    /isFeatureEnabled\(authz\.user\.orgId, "payroll"\)/,
    'payroll tools must refuse when Payroll is off',
  )
  assert.match(
    read('lib/custom-reports.ts'),
    /reportEntityFeatureKey\(query\)/,
    'executeReport must refuse optional-module entities when the Features switch is off',
  )
  assert.match(
    read('lib/custom-reports.ts'),
    /isFeatureEnabled\(orgId, featureKey\)/,
    'executeReport must consult Features, not only a stored plan',
  )
  assert.match(
    read('app/api/internal/reports/render/route.ts'),
    /feature is disabled/,
    'scheduled/internal render must refuse optional-module output when the feature is off',
  )
  assert.match(
    read('app/api/internal/reports/render/route.ts'),
    /status: 404/,
    'scheduled/internal render must 404 — not emit a PDF — when the feature is off',
  )
  assert.equal(routeGateState('/analytics/true-cost'), 'gated')
  assert.equal(routeGateState('/analytics/utilization'), 'gated')
  assert.match(
    read('app/(app)/analytics/page.tsx'),
    /isFeatureEnabled\(authz\.user\.orgId, 'projects'\)/,
    'analytics hub must hide true-cost when Projects is off',
  )
  assert.match(
    read('app/(app)/analytics/page.tsx'),
    /isFeatureEnabled\(authz\.user\.orgId, 'timeTracking'\)/,
    'analytics hub must hide utilization when Time Tracking is off',
  )
  assert.match(
    read('app/(app)/analytics/true-cost/page.tsx'),
    /requireFeatureEnabled\([^,]+, 'projects'\)/,
    'true-cost page must 404 when Projects is off',
  )
  assert.match(
    read('app/(app)/analytics/utilization/page.tsx'),
    /requireFeatureEnabled\([^,]+, 'timeTracking'\)/,
    'utilization page must 404 when Time Tracking is off',
  )
  assert.match(
    read('app/(app)/analytics/financial-health/page.tsx'),
    /isFeatureEnabled\([^,]+, 'budgets'\)/,
    'financial-health must hide the budget section when Budgets is off',
  )
  assert.match(
    read('app/(app)/analytics/financial-health/FinancialHealthView.tsx'),
    /budgetsEnabled/,
    'financial-health budget tab must not render when Budgets is off',
  )
  assert.match(
    read('lib/analytics/health-data.ts'),
    /isFeatureEnabled\(orgId, "budgets"\)/,
    'financial-health must not load budget variance when Budgets is off',
  )
  assert.match(
    read('lib/analytics/customer-data.ts'),
    /isFeatureEnabled\(orgId, "projects"\)/,
    'job-costed customer profitability must not load when Projects is off',
  )
  assert.match(
    read('app/(app)/analytics/customer-intelligence/page.tsx'),
    /isFeatureEnabled\([^,]+, 'projects'\)/,
    'customer-intelligence must hide job-costed profitability when Projects is off',
  )
  assert.match(
    read('app/(app)/analytics/customer-intelligence/CustomerView.tsx'),
    /projectsEnabled/,
    'customer-intelligence profitability tab must not render when Projects is off',
  )
  assert.match(
    read('app/api/analytics/true-cost/config/route.ts'),
    /guardFeaturePermission\("reports\.read", "projects"\)/,
    'true-cost config must 404 when Projects is off',
  )
  assert.match(
    read('app/api/analytics/utilization/entries/route.ts'),
    /guardFeaturePermission\("reports\.read", "timeTracking"\)/,
    'utilization entries must 404 when Time Tracking is off',
  )
  assert.match(
    read('app/api/analytics/config/[dashboard]/route.ts'),
    /utilization: "timeTracking"/,
    'utilization dashboard config must follow the Time Tracking switch',
  )
  assert.match(
    read('lib/setup/number-sequence-kinds.ts'),
    /SEQUENCE_KIND_FEATURE/,
    'number-sequence writers must not offer optional-module kinds when the parent feature is off',
  )
  assert.match(
    read('../packages/reports/src/entities.ts'),
    /key: 'projects'[\s\S]{0,200}featureKey: 'projects'/,
    'the projects report entity must follow the Projects switch',
  )
  assert.match(
    read('../packages/reports/src/entities.ts'),
    /key: 'timesheets'[\s\S]{0,200}featureKey: 'timeTracking'/,
    'the timesheets report entity must follow the Time Tracking switch',
  )
  assert.match(
    read('../packages/reports/src/entities.ts'),
    /key: 'fixed_assets'[\s\S]{0,200}featureKey: 'fixedAssets'/,
    'the fixed-assets report entity must follow the Fixed Assets switch',
  )
  assert.match(
    read('../packages/reports/src/entities.ts'),
    /key: 'equipment'[\s\S]{0,200}featureKey: 'equipment'/,
    'the equipment report entity must follow the Equipment switch',
  )
  assert.match(
    read('../packages/reports/src/entities.ts'),
    /requiredPermission: 'payroll.read',\s*featureKey: 'payroll'/,
    'payroll wage entities must follow the Payroll switch, not only payroll.read',
  )
})

test('the report catalog page filters entities the reader cannot run', () => {
  // The list exposes names, slugs and the stored PLAN, and the counts expose
  // how many exist. Both are disclosures; both are filtered — permission and
  // the Features switch.
  const page = read('app/(app)/reports/custom/page.tsx')
  assert.match(page, /hiddenReportEntityKeys/)
  assert.match(page, /hiddenReportStatementKinds/)
  assert.match(page, /const visible =/)
  const countsQuery = page.slice(page.indexOf('select kind, count(*)'))
  assert.match(
    countsQuery.slice(0, 200),
    /\$\{visible\}/,
    'the kind counts must apply the same entity filter as the list',
  )
})
