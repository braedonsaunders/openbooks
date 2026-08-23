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
  bankFeeds: [
    'app/api/banking/bank-feeds',
    'app/api/banking/sftp',
  ],
  crm: ['app/api/crm', 'app/api/parties/[id]/activities'],
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
    'app/api/ap-capture/[id]/route.ts',
    'app/api/record-pdf/[recordType]/[id]/route.ts',
    'app/api/record-pdf/[recordType]/options/route.ts',
    'app/api/record-pdf/[recordType]/[id]/send/route.ts',
    'app/api/pdf-templates/route.ts',
    'app/api/pdf-templates/[id]/route.ts',
    'app/api/pdf-templates/preview/route.ts',
    'app/(app)/ap/capture/page.tsx',
    'app/(app)/admin/pdf-templates/[id]/page.tsx',
    'lib/application/documents.ts',
    'lib/api/writers.ts',
    'lib/assistant/tools.ts',
    'lib/crm.ts',
    'lib/documents.ts',
    'components/related-transaction-drawer.tsx',
  ]) {
    assert.match(read(file), /isDocKindEnabled\(/, `${file} must refuse optional-module kinds when the feature is off`)
  }
  assert.match(
    read('app/api/documents/[id]/route.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'document line writes must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('app/api/documents/[id]/route.ts'),
    /storedIds\.has\(line\.itemId\)/,
    'document PATCH must keep stored inventory lines when Inventory is off',
  )
  assert.match(
    read('app/api/documents/[id]/route.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'document PATCH must 404 — not persist new inventory/assembly/kit lines — when Inventory is off',
  )
  assert.match(
    read('app/api/documents/[id]/route.ts'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'document PATCH must refuse equipment_charge when Equipment is off — stored lines stay',
  )
  assert.match(
    read('app/api/documents/[id]/route.ts'),
    /kind === 'equipment_charge'[\s\S]{0,200}status: 404/,
    'document PATCH must 404 — not persist equipment_charge lines — when Equipment is off',
  )
  for (const file of [
    'app/(app)/ar/invoices/page.tsx',
    'app/(app)/ap/bills/page.tsx',
    'app/(app)/banking/transactions/page.tsx',
    'components/related-transaction-drawer.tsx',
  ]) {
    assert.match(
      read(file),
      /isFeatureEnabled\([^,]+, ['"]inventory['"]\)/,
      `${file} must not offer inventory/assembly/kit items when Inventory is off`,
    )
    assert.match(
      read(file),
      /kind not in \('inventory', 'assembly', 'kit'\)/,
      `${file} must drop inventory/assembly/kit from the picker when Inventory is off — stored lines stay`,
    )
    assert.match(
      read(file),
      /isFeatureEnabled\([^,]+, ['"]equipment['"]\)/,
      `${file} must not offer equipment_charge items when Equipment is off`,
    )
    assert.match(
      read(file),
      /kind <> 'equipment_charge'/,
      `${file} must drop equipment_charge from the picker when Equipment is off — stored lines stay`,
    )
  }
  assert.match(
    read('lib/search.ts'),
    /disabledDocKinds\(/,
    'global search must hide optional-module kinds when the feature is off',
  )
  assert.match(
    read('lib/module-home/customers.ts'),
    /isFeatureEnabled\(orgId, 'orders'\)/,
    'customer home must not count quotes/sales orders when Orders is off',
  )
  assert.match(
    read('lib/module-home/customers.ts'),
    /isFeatureEnabled\(orgId, 'crm'\)/,
    'customer home must not count opportunities or pipeline when CRM is off',
  )
  assert.match(
    read('lib/module-home/customers.ts'),
    /crmOn \? calculateForecast/,
    'customer home must not load the forecast rollup when CRM is off — stored opportunities stay',
  )
  assert.match(
    read('lib/module-home/purchasing.ts'),
    /isFeatureEnabled\(orgId, 'orders'\)/,
    'purchasing home must not count purchase orders when Orders is off',
  )
  assert.match(
    read('lib/module-home/purchasing.ts'),
    /isFeatureEnabled\(orgId, 'expenses'\)/,
    'purchasing home must not count unposted expenses when Expenses is off',
  )
  assert.match(
    read('app/(app)/customers/page.tsx'),
    /data\.ordersEnabled/,
    'customer home must hide the quotes/orders vital when Orders is off',
  )
  assert.match(
    read('app/(app)/customers/page.tsx'),
    /data\.crmEnabled/,
    'customer home must hide pipeline vitals when CRM is off',
  )
  assert.match(
    read('app/(app)/customers/RelationshipsTable.tsx'),
    /crmEnabled \? <th/,
    'customer home must hide the open-opps column when CRM is off — stored opportunities stay',
  )
  assert.match(
    read('app/(app)/purchasing/page.tsx'),
    /data\.ordersEnabled/,
    'purchasing home must hide the open-PO vital when Orders is off',
  )
  assert.match(
    read('app/(app)/purchasing/page.tsx'),
    /data\.expensesEnabled/,
    'purchasing home must hide the unposted-expense vital when Expenses is off',
  )
  assert.match(
    read('app/(app)/ap/capture/page.tsx'),
    /isDocKindEnabled\([^,]+, 'purchase_order'\)/,
    'AP capture must not look up purchase orders when Orders is off',
  )
  assert.match(
    read('app/api/ap-capture/[id]/route.ts'),
    /isDocKindEnabled\([^,]+, 'purchase_order'\)/,
    'AP capture must refuse a new PO assignment when Orders is off',
  )
  assert.match(
    read('app/api/ap-capture/[id]/route.ts'),
    /status: 404/,
    'AP capture must 404 — not attach a PO — when Orders is off',
  )
  assert.match(
    read('app/(app)/admin/pdf-templates/page.tsx'),
    /disabledDocKinds\(/,
    'PDF template catalog must hide quote/SO/PO/expense-report kinds when the feature is off',
  )
  for (const file of [
    'app/api/record-pdf/[recordType]/[id]/route.ts',
    'app/api/record-pdf/[recordType]/options/route.ts',
    'app/api/record-pdf/[recordType]/[id]/send/route.ts',
  ]) {
    assert.match(read(file), /status: 404/, `${file} must 404 optional-module PDFs when the feature is off`)
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
  assert.match(
    read('app/api/crm/opportunities/[id]/estimate/route.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'CRM estimate must name the inventory kinds the Features switch 404s',
  )
  assert.match(
    read('app/api/crm/opportunities/[id]/estimate/route.ts'),
    /isFeatureEnabled\([^,]+, 'inventory'\)[\s\S]{0,400}INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'CRM estimate must 404 — not copy inventory/assembly/kit onto a quote — when Inventory is off',
  )
  assert.match(
    read('app/api/_order/handlers.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'quote/SO/PO line writes must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('app/api/_order/handlers.ts'),
    /storedIds\.has\(l\.itemId\)/,
    'quote/SO/PO PATCH must keep stored inventory lines when Inventory is off',
  )
  assert.match(
    read('app/api/_order/handlers.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'quote/SO/PO PATCH must 404 — not persist new inventory/assembly/kit lines — when Inventory is off',
  )
  assert.match(
    read('app/api/timesheets/route.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'timesheet line writes must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('app/api/timesheets/route.ts'),
    /storedIds\.has\(p\.itemId\)/,
    'timesheet save must keep stored inventory items when Inventory is off',
  )
  assert.match(
    read('app/api/timesheets/route.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'timesheet save must 404 — not persist new inventory/assembly/kit items — when Inventory is off',
  )
  assert.match(
    read('app/api/timesheets/route.ts'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'timesheet save must refuse equipment_charge when Equipment is off — stored week entries stay',
  )
  assert.match(
    read('app/api/timesheets/route.ts'),
    /kind === 'equipment_charge'[\s\S]{0,200}status: 404/,
    'timesheet save must 404 — not persist new equipment_charge items — when Equipment is off',
  )
  assert.match(
    read('app/api/timesheets/_lib.ts'),
    /isFeatureEnabled\([^,]+, ['"]equipment['"]\)/,
    'the timesheet item picker must read the Equipment switch before offering equipment_charge',
  )
  assert.match(
    read('app/api/timesheets/_lib.ts'),
    /equipmentEnabled \? \['equipment_charge'\]/,
    'the timesheet item picker must drop equipment_charge when Equipment is off — stored week entries stay',
  )
  assert.match(
    read('lib/order-cycle.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'order conversion must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('lib/order-cycle.ts'),
    /INVENTORY_ITEM_KINDS\.has\([^)]+\)[\s\S]{0,80}Inventory is disabled/,
    'convertOrder must not copy inventory/assembly/kit lines when Inventory is off — source lines stay',
  )
  assert.match(
    read('lib/order-cycle.ts'),
    /kind === 'equipment_charge'[\s\S]{0,80}Equipment is disabled/,
    'convertOrder must not copy equipment_charge lines when Equipment is off — stored source order lines stay',
  )
  assert.match(
    read('lib/order-cycle.ts'),
    /ConversionError\('Equipment is disabled', 404\)/,
    'convertOrder must 404 — not persist equipment_charge — when Equipment is off',
  )
  assert.match(
    read('app/api/_order/handlers.ts'),
    /e instanceof ConversionError[\s\S]{0,80}status: e\.status/,
    'order convert must 404 — not persist equipment_charge — when Equipment is off',
  )
  for (const file of [
    'app/api/estimates/[id]/convert/route.ts',
    'app/api/sales-orders/[id]/convert/route.ts',
    'app/api/purchase-orders/[id]/convert/route.ts',
  ]) {
    assert.match(
      read(file),
      /conversionWouldCopyInventoryKinds[\s\S]{0,200}status: 404/,
      `${file} must 404 — not copy inventory/assembly/kit — when Inventory is off`,
    )
  }
  for (const file of [
    'app/(app)/estimates/page.tsx',
    'app/(app)/sales-orders/page.tsx',
    'app/(app)/purchase-orders/page.tsx',
  ]) {
    assert.match(
      read(file),
      /isFeatureEnabled\([^,]+, ['"]inventory['"]\)/,
      `${file} must not offer inventory/assembly/kit items when Inventory is off`,
    )
    assert.match(
      read(file),
      /kind not in \('inventory', 'assembly', 'kit'\)/,
      `${file} must drop inventory/assembly/kit from the picker when Inventory is off — stored lines stay`,
    )
  }
  assert.match(
    read('lib/billing.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'invoice generate must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('lib/billing.ts'),
    /INVENTORY_ITEM_KINDS\.has\([^)]+\)[\s\S]{0,80}Inventory is disabled/,
    'generateInvoiceFromBillingRequest must not persist inventory/assembly/kit lines when Inventory is off — stored time/cost rows and existing invoices stay',
  )
  assert.match(
    read('app/api/billing-requests/[id]/create-invoice/route.ts'),
    /Inventory is disabled[\s\S]{0,200}status: 404/,
    'invoice generate must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('lib/billing.ts'),
    /kind === 'equipment_charge'[\s\S]{0,80}Equipment is disabled/,
    'generateInvoiceFromBillingRequest must not persist equipment_charge lines when Equipment is off — stored time/cost rows and existing invoices stay',
  )
  assert.match(
    read('app/api/billing-requests/[id]/create-invoice/route.ts'),
    /Equipment is disabled[\s\S]{0,200}status: 404/,
    'invoice generate must 404 — not persist equipment_charge — when Equipment is off',
  )
  assert.match(
    read('lib/wip-billing.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'prebill convert must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('lib/wip-billing.ts'),
    /INVENTORY_ITEM_KINDS\.has\([^)]+\)[\s\S]{0,80}Inventory is disabled/,
    'convertPrebill must not copy inventory/assembly/kit lines when Inventory is off — stored prebill lines and existing invoices stay',
  )
  assert.match(
    read('lib/wip-billing.ts'),
    /WipBillingError\('Inventory is disabled', 404\)/,
    'convertPrebill must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('lib/wip-billing.ts'),
    /kind === 'equipment_charge'[\s\S]{0,80}Equipment is disabled/,
    'convertPrebill must not copy equipment_charge lines when Equipment is off — stored prebill lines and existing invoices stay',
  )
  assert.match(
    read('lib/wip-billing.ts'),
    /WipBillingError\('Equipment is disabled', 404\)/,
    'convertPrebill must 404 — not persist equipment_charge — when Equipment is off',
  )
  assert.match(
    read('../engine/src/subscription-billing.ts'),
    /\["inventory", "assembly", "kit"\]/,
    'subscription invoice generate must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('../engine/src/subscription-billing.ts'),
    /INVENTORY_ITEM_KINDS\.has\([^)]+\)[\s\S]{0,80}Inventory is disabled/,
    'createSubscriptionInvoice must not persist inventory/assembly/kit lines when Inventory is off — stored subscriptions and existing invoices stay',
  )
  assert.match(
    read('../engine/src/subscription-billing.ts'),
    /SubscriptionError\("Inventory is disabled", 404\)/,
    'createSubscriptionInvoice must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('../engine/src/subscription-billing.ts'),
    /kind === "equipment_charge"[\s\S]{0,80}Equipment is disabled/,
    'createSubscriptionInvoice must not persist equipment_charge lines when Equipment is off — stored subscriptions and existing invoices stay',
  )
  assert.match(
    read('../engine/src/subscription-billing.ts'),
    /SubscriptionError\("Equipment is disabled", 404\)/,
    'createSubscriptionInvoice must 404 — not persist equipment_charge — when Equipment is off',
  )
  assert.match(
    read('app/api/subscriptions/route.ts'),
    /e instanceof SubscriptionError[\s\S]{0,120}status: e\.status/,
    'subscription bill-now must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('app/api/subscriptions/route.ts'),
    /\["inventory", "assembly", "kit"\]/,
    'subscription plan writes must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('app/api/subscriptions/route.ts'),
    /item_id = \$\{body\.itemId !== undefined \? body\.itemId \?\? null : sql`item_id`\}/,
    'subscription plan update must keep stored item_id when omitted',
  )
  assert.match(
    read('app/api/subscriptions/route.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'subscription addPlan/updatePlan must 404 — not persist inventory/assembly/kit items — when Inventory is off',
  )
  assert.match(
    read('app/api/subscriptions/route.ts'),
    /kind === "equipment_charge"[\s\S]{0,80}isFeatureEnabled\([^,]+, "equipment"\)/,
    'refuseInventoryPlanItem must not persist equipment_charge items when Equipment is off — stored plans stay when itemId is omitted',
  )
  assert.match(
    read('app/api/subscriptions/route.ts'),
    /kind === "equipment_charge"[\s\S]{0,160}status: 404/,
    'subscription addPlan/updatePlan must 404 — not persist equipment_charge items — when Equipment is off',
  )
  assert.match(
    read('../engine/src/advanced-subscriptions.ts'),
    /\["inventory", "assembly", "kit"\]/,
    'advanced subscription component writes must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('../engine/src/advanced-subscriptions.ts'),
    /INVENTORY_ITEM_KINDS\.has\([^)]+\)[\s\S]{0,80}Inventory is disabled/,
    'assertCommercialRefs must not persist inventory/assembly/kit items when Inventory is off — stored components stay when itemId is omitted',
  )
  assert.match(
    read('../engine/src/advanced-subscriptions.ts'),
    /AdvancedSubscriptionError\("Inventory is disabled", 404\)/,
    'createPlanVersion and change-order add/change component must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('../engine/src/advanced-subscriptions.ts'),
    /kind === "equipment_charge"[\s\S]{0,80}Equipment is disabled/,
    'assertCommercialRefs must not persist equipment_charge items when Equipment is off — stored components stay when itemId is omitted',
  )
  assert.match(
    read('../engine/src/advanced-subscriptions.ts'),
    /AdvancedSubscriptionError\("Equipment is disabled", 404\)/,
    'createPlanVersion and change-order add/change component must 404 — not persist equipment_charge — when Equipment is off',
  )
  assert.match(
    read('app/api/subscriptions/advanced/route.ts'),
    /error instanceof AdvancedSubscriptionError[\s\S]{0,160}status: error\.status/,
    'advanced subscription writes must 404 — not persist inventory/assembly/kit items — when Inventory is off',
  )
  assert.match(
    read('../engine/src/ap-capture-service.ts'),
    /\["inventory", "assembly", "kit"\]/,
    'AP capture materialize must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('../engine/src/ap-capture-service.ts'),
    /INVENTORY_ITEM_KINDS\.has\([^)]+\)[\s\S]{0,80}Inventory is disabled/,
    'materializeCapture must not persist inventory/assembly/kit lines when Inventory is off — stored captures and existing bills stay',
  )
  assert.match(
    read('../engine/src/ap-capture-service.ts'),
    /CaptureMaterializationError\("Inventory is disabled", 404\)/,
    'materializeCapture must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('../engine/src/ap-capture-service.ts'),
    /kind === "equipment_charge"[\s\S]{0,80}Equipment is disabled/,
    'materializeCapture must not persist equipment_charge lines when Equipment is off — stored captures and existing bills stay',
  )
  assert.match(
    read('../engine/src/ap-capture-service.ts'),
    /CaptureMaterializationError\("Equipment is disabled", 404\)/,
    'materializeCapture must 404 — not persist equipment_charge — when Equipment is off',
  )
  assert.match(
    read('app/api/ap-capture/[id]/materialize/route.ts'),
    /error instanceof CaptureMaterializationError[\s\S]{0,160}status: error\.status/,
    'AP capture materialize must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('app/api/ap-capture/[id]/route.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'AP capture PATCH must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('app/api/ap-capture/[id]/route.ts'),
    /storedIds\.has\(line\.itemId\)/,
    'AP capture PATCH must keep stored item_id when omitted',
  )
  assert.match(
    read('app/api/ap-capture/[id]/route.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'AP capture PATCH must 404 — not persist new inventory/assembly/kit items — when Inventory is off',
  )
  assert.match(
    read('app/api/ap-capture/[id]/route.ts'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'AP capture PATCH must refuse equipment_charge when Equipment is off — stored lines stay',
  )
  assert.match(
    read('app/api/ap-capture/[id]/route.ts'),
    /kind === 'equipment_charge'[\s\S]{0,200}status: 404/,
    'AP capture PATCH must 404 — not persist new equipment_charge items — when Equipment is off',
  )
  assert.match(
    read('app/api/labor-rate-cards/[id]/route.ts'),
    /\["inventory", "assembly", "kit"\]/,
    'labor rate-card line writes must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('app/api/labor-rate-cards/[id]/route.ts'),
    /storedIds\.has\(line\.itemId\)/,
    'labor rate-card save must keep stored item_id when omitted',
  )
  assert.match(
    read('app/api/labor-rate-cards/[id]/route.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'labor rate-card save must 404 — not persist new inventory/assembly/kit items — when Inventory is off',
  )
  assert.match(
    read('app/api/labor-rate-cards/[id]/route.ts'),
    /targetType !== "item"[\s\S]{0,80}storedTargetIds\.has\(target\.targetValueId\)/,
    'labor rate-card adjustment item targets must keep stored target_value_id when omitted',
  )
  assert.match(
    read('app/api/labor-rate-cards/[id]/route.ts'),
    /storedTargetIds\.has\(target\.targetValueId\)[\s\S]{0,280}INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'labor rate-card adjustment item targets must 404 — not persist new inventory/assembly/kit items — when Inventory is off',
  )
  assert.match(
    read('app/api/items/[id]/rates/route.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'item rate save must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('app/api/items/[id]/rates/route.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'item rate save must 404 — not persist inventory/assembly/kit rate lines — when Inventory is off — stored rate lines stay',
  )
  assert.match(
    read('app/api/items/[id]/rates/route.ts'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'item rate save must refuse equipment_charge when Equipment is off — stored rate lines stay',
  )
  assert.match(
    read('app/api/items/[id]/rates/route.ts'),
    /kind === 'equipment_charge'[\s\S]{0,200}status: 404/,
    'item rate save must 404 — not persist — equipment_charge rate lines when Equipment is off',
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
  assert.match(
    read('../engine/src/flows/scheduled.ts'),
    /coalesce\(\(organization\.settings->'features'->>'flows'\)::boolean, true\)/,
    'scheduled flows must not fire when the Flows switch is off',
  )
  assert.match(
    read('../engine/src/flows/gates.ts'),
    /coalesce\(\(organization\.settings->'features'->>'flows'\)::boolean, true\)/,
    'gate reminder/escalation timers must not fire when the Flows switch is off',
  )
  assert.match(
    read('../engine/src/continuous-close.ts'),
    /coalesce\(\(o\.settings->'features'->>'continuousClose'\)::boolean, true\)/,
    'scheduled continuous-close agents must not scan when Continuous Close is off',
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
  assert.match(
    read('../packages/customization/src/types.ts'),
    /featureKey\?: string/,
    'the record-type catalog must declare an optional-module featureKey',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /function orderRecordType[\s\S]{0,400}featureKey: "orders"/,
    'quote / sales order / purchase order customization must follow the Orders switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /function crmAccountRecordType[\s\S]{0,300}featureKey: "crm"/,
    'lead / prospect list views must follow the CRM switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /const PROJECT: RecordTypeMeta = \{[\s\S]{0,250}featureKey: "projects"/,
    'project customization must follow the Projects switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "expense_report"[\s\S]{0,200}featureKey: "expenses"/,
    'expense-report customization must follow the Expenses switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "inventory_onhand"[\s\S]{0,200}featureKey: "inventory"/,
    'inventory list views must follow the Inventory switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /ITEM_INVENTORY_KIND_VALUES/,
    'item list-filter options must name the inventory kinds the Features switch hides',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /function recordTypeForFeatureState[\s\S]{0,800}ITEM_INVENTORY_KIND_VALUES/,
    'item list-filter options must drop inventory/assembly/kit when Inventory is off',
  )
  assert.match(
    read('components/entity-list-view.tsx'),
    /recordTypeForFeatureState\([\s\S]{0,120}inventory/,
    'the entity list must hide inventory item-kind chips when Inventory is off',
  )
  assert.match(
    read('app/(app)/admin/customization/ListViewDesigner.tsx'),
    /recordTypeForFeatureState\([\s\S]{0,120}inventory/,
    'the list view designer must hide inventory item kinds when Inventory is off',
  )
  assert.match(
    read('app/(app)/admin/customization/page.tsx'),
    /isFeatureEnabled\([^,]+, 'inventory'\)/,
    'the list view designer must read the Inventory switch before offering item kinds',
  )
  assert.match(
    read('../packages/reports/src/entities.ts'),
    /ITEM_INVENTORY_KIND_VALUES/,
    'items report kind options must name the inventory kinds the Features switch hides',
  )
  assert.match(
    read('../packages/reports/src/entities.ts'),
    /function reportEntityForFeatureState[\s\S]{0,400}ITEM_INVENTORY_KIND_VALUES/,
    'items report kind options must drop inventory/assembly/kit when Inventory is off',
  )
  assert.match(
    read('app/(app)/reports/custom/FilterTree.tsx'),
    /reportEntityForFeatureState\([\s\S]{0,120}inventory/,
    'the report filter picker must hide inventory item kinds when Inventory is off',
  )
  assert.match(
    read('app/(app)/reports/custom/builder/[id]/page.tsx'),
    /isFeatureEnabled\([^,]+, 'inventory'\)/,
    'the report builder must read the Inventory switch before offering item kinds',
  )
  assert.match(
    read('app/(app)/knowledge/views/page.tsx'),
    /isFeatureEnabled\([^,]+, 'inventory'\)/,
    'the view studio must read the Inventory switch before offering item kinds',
  )
  assert.match(
    read('../packages/analytics/src/catalog.ts'),
    /function insightSourceForFeatureState[\s\S]{0,400}ITEM_INVENTORY_KIND_VALUES/,
    'items insight kind options must drop inventory/assembly/kit when Inventory is off',
  )
  assert.match(
    read('app/(app)/insights/CardStudio.tsx'),
    /insightSourceForFeatureState\([\s\S]{0,120}inventory/,
    'the insight card filter picker must hide inventory item kinds when Inventory is off',
  )
  assert.match(
    read('app/(app)/insights/page.tsx'),
    /isFeatureEnabled\([^,]+, 'inventory'\)/,
    'the insight card studio must read the Inventory switch before offering item kinds',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "budget_scenario"[\s\S]{0,200}featureKey: "budgets"/,
    'budget-scenario list views must follow the Budgets switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "revenue_contract"[\s\S]{0,200}featureKey: "revenueRecognition"/,
    'revenue-contract list views must follow the Revenue Recognition switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "equipment_unit"[\s\S]{0,200}featureKey: "equipment"/,
    'equipment list views must follow the Equipment switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "timesheet_week"[\s\S]{0,200}featureKey: "timeTracking"/,
    'timesheet list views must follow the Time Tracking switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "fixed_asset"[\s\S]{0,200}featureKey: "fixedAssets"/,
    'fixed-asset customization must follow the Fixed Assets switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "property"[\s\S]{0,200}featureKey: "propertyManagement"/,
    'property customization must follow the Property Management switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "labor_rate_card"[\s\S]{0,200}featureKey: "projects"/,
    'labor-rate-card customization must follow the Projects parent gate',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "field_ticket"[\s\S]{0,200}featureKey: "fieldTickets"/,
    'field-ticket customization must follow the Field Tickets switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "pay_run"[\s\S]{0,200}featureKey: "payroll"/,
    'pay-run list views must follow the Payroll switch',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /key: "opportunity"[\s\S]{0,200}featureKey: "crm"/,
    'opportunity list views must follow the CRM switch',
  )
  assert.match(
    read('lib/customization/gates.ts'),
    /recordTypeFeatureKey\(recordType\)/,
    'customization gates must consult the catalog featureKey',
  )
  assert.match(
    read('lib/customization/gates.ts'),
    /status: 404/,
    'disabled record types must 404 — not write — when the feature is off',
  )
  assert.match(
    read('app/(app)/admin/customization/page.tsx'),
    /disabledRecordTypes\(/,
    'the customization catalog must hide optional-module kinds when the feature is off',
  )
  assert.match(
    read('app/(app)/admin/customization/page.tsx'),
    /notFound\(\)/,
    'a disabled record type must 404 — not open the designer',
  )
  for (const file of [
    'app/api/customization/list-views/route.ts',
    'app/api/customization/list-views/[id]/route.ts',
    'app/api/customization/form-layouts/route.ts',
    'app/api/customization/form-layouts/[id]/route.ts',
    'app/api/customization/list-preferences/route.ts',
    'app/api/customization/form-preferences/route.ts',
  ]) {
    assert.match(read(file), /refuseDisabledRecordType\(/, `${file} must refuse optional-module kinds when the feature is off`)
  }
  assert.match(
    read('app/api/admin/custom-fields/route.ts'),
    /isCustomFieldTargetEnabled\(/,
    'custom-field writes must refuse optional-module targets when the feature is off',
  )
  assert.match(
    read('app/api/admin/custom-fields/route.ts'),
    /status: 404/,
    'custom-field writes must 404 — not persist — when the feature is off',
  )
  assert.match(
    read('app/(app)/admin/custom-fields/page.tsx'),
    /disabledCustomFieldTargets\(/,
    'the custom-fields list must hide optional-module targets when the feature is off',
  )
  assert.match(
    read('app/api/banking/sftp/daemon/route.ts'),
    /guardFeaturePermission\('admin\.setup\.manage', 'bankFeeds'\)/,
    'inbound SFTP daemon writes must refuse when Bank Feeds is off',
  )
  assert.match(
    read('app/api/banking/sftp/schedules/route.ts'),
    /guardFeaturePermission\('admin\.setup\.manage', 'bankFeeds'\)/,
    'SFTP import-schedule writes must refuse when Bank Feeds is off',
  )
  assert.match(
    read('app/api/banking/sftp/route.ts'),
    /guardFeaturePermission\('admin\.setup\.manage', 'bankFeeds'\)/,
    'SFTP server create must refuse when Bank Feeds is off',
  )
  assert.match(
    read('app/api/banking/sftp/[id]/route.ts'),
    /guardFeaturePermission\('admin\.setup\.manage', 'bankFeeds'\)/,
    'SFTP server rotate/delete must refuse when Bank Feeds is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /setupEntityEnabled\(/,
    'setup import/export must hide optional-module entities when the feature is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /isDocKindEnabled\(/,
    'transaction import must refuse optional-module kinds when the feature is off',
  )
  assert.match(
    read('../engine/src/fx-providers.ts'),
    /coalesce\(\(organization\.settings->'features'->>'multiCurrency'\)::boolean, false\)/,
    'scheduled FX imports must not write rates when Multi-currency is off',
  )
  assert.match(
    read('../engine/src/fx-providers.ts'),
    /multiCurrencyFeatureEnabled\(orgId\)/,
    'manual FX sync must refuse when Multi-currency is off',
  )
  assert.match(
    read('../engine/src/close.ts'),
    /if \(!\(await advancedCloseEnabled\(context\.orgId\)\)\) return \{ completed: 0, failed: 0 \}/,
    'close automations must not fire when Advanced close is off — core close still runs',
  )
  assert.match(
    read('../engine/src/close.ts'),
    /coalesce\(\(organization\.settings->'features'->>'advancedClose'\)::boolean, false\)/,
    'scheduled close automations must skip orgs whose Advanced close switch is off',
  )
  assert.match(
    read('../engine/src/close.ts'),
    /export async function publishCloseRun[\s\S]{0,200}advancedCloseEnabled/,
    'publishCloseRun must refuse when Advanced close is off — stored binders stay',
  )
  assert.match(
    read('app/api/close/runs/[id]/route.ts'),
    /action === "publish"[\s\S]{0,80}isFeatureEnabled\([^,]+, "advancedClose"\)[\s\S]{0,160}status: 404/,
    'close-package publish must 404 — not persist — when Advanced close is off — stored binders stay',
  )
  assert.match(
    read('lib/application/close.ts'),
    /action === "publish"[\s\S]{0,80}isFeatureEnabled\([^,]+, "advancedClose"\)/,
    'MCP/assistant publish_close_package must refuse when Advanced close is off',
  )
  assert.match(
    read('lib/application/close.ts'),
    /action === "publish"[\s\S]{0,160}notFound\(/,
    'MCP/assistant publish_close_package must 404 when Advanced close is off',
  )
  assert.match(
    read('app/(app)/close/CloseWizard.tsx'),
    /advancedClose[\s\S]{0,80}STAGES[\s\S]{0,80}stage !== "publish"/,
    'the close wizard must omit the publish stage when Advanced close is off',
  )
  assert.match(
    read('app/(app)/close/CloseWizard.tsx'),
    /props\.advancedClose && props\.run\.status !== "published"/,
    'the close wizard must hide the publish action when Advanced close is off — stored binders stay',
  )
  assert.match(
    read('../engine/src/worker/overhead-scheduler.ts'),
    /coalesce\(\(settings->'features'->>'projects'\)::boolean, true\)/,
    'scheduled overhead publish must skip orgs whose Projects switch is off',
  )
  assert.match(
    read('../engine/src/recurring.ts'),
    /when 'quote' then coalesce\(\(o\.settings->'features'->>'orders'\)::boolean, true\)/,
    'scheduled recurring must not mint quotes/orders when Orders is off',
  )
  assert.match(
    read('../engine/src/recurring.ts'),
    /when 'expense_report' then coalesce\(\(o\.settings->'features'->>'expenses'\)::boolean, true\)/,
    'scheduled recurring must not mint expense reports when Expenses is off',
  )
  assert.match(
    read('../engine/src/recurring.ts'),
    /isRecurringKindEnabled\(orgId, String\(tpl\.kind\)\)/,
    'recurring generate-now must refuse optional-module kinds when the feature is off',
  )
  assert.match(
    read('../engine/src/recurring.ts'),
    /\["inventory", "assembly", "kit"\]/,
    'recurring generate must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('../engine/src/recurring.ts'),
    /INVENTORY_ITEM_KINDS\.has\([^)]+\)[\s\S]{0,80}Inventory is disabled/,
    'generateFromTemplate must not persist inventory/assembly/kit lines when Inventory is off — stored templates and existing documents stay',
  )
  assert.match(
    read('../engine/src/recurring.ts'),
    /RecurringError\("Inventory is disabled", 404\)/,
    'generateFromTemplate must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('../engine/src/recurring.ts'),
    /kind === "equipment_charge"[\s\S]{0,80}Equipment is disabled/,
    'generateFromTemplate must not persist equipment_charge lines when Equipment is off — stored templates and existing documents stay',
  )
  assert.match(
    read('../engine/src/recurring.ts'),
    /RecurringError\("Equipment is disabled", 404\)/,
    'generateFromTemplate must 404 — not persist equipment_charge — when Equipment is off',
  )
  assert.match(
    read('app/api/recurring/[id]/route.ts'),
    /e instanceof RecurringError[\s\S]{0,120}status: e\.status/,
    'recurring run-now must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('app/api/recurring/route.ts'),
    /isDocKindEnabled\(/,
    'recurring schedule create must refuse optional-module templates when the feature is off',
  )
  assert.match(
    read('app/api/recurring/route.ts'),
    /disabledDocKinds\(/,
    'the recurring list must hide optional-module schedules when the feature is off',
  )
  assert.match(
    read('app/api/recurring/[id]/route.ts'),
    /isDocKindEnabled\(/,
    'recurring run-now / patch must 404 optional-module schedules when the feature is off',
  )
  assert.match(
    read('app/api/recurring/[id]/route.ts'),
    /status: 404/,
    'recurring run-now must 404 — not mint — when the template kind is off',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /export async function addLeaseCharge[\s\S]{0,400}await assertEnabled\(db, input\.orgId\)/,
    'lease-charge writes must refuse when Property Management is off — existing charges stay',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /export async function scheduleLeaseCharges[\s\S]{0,200}await assertEnabled\(db, orgId\)/,
    'lease-schedule writes must refuse when Property Management is off — existing schedule lines stay',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /export async function finalizeCamPool[\s\S]{0,200}await assertEnabled\(tx, orgId\)/,
    'CAM finalize must refuse when Property Management is off — existing pools stay',
  )
  assert.match(
    read('../engine/src/revenue-recognition.ts'),
    /export async function createObligationsFromInvoice[\s\S]{0,400}revenueRecognitionFeatureEnabled\(db, orgId\)/,
    'invoice posting must not mint obligations when Revenue Recognition is off — existing schedules stay',
  )
  assert.match(
    read('../engine/src/revenue-recognition.ts'),
    /export async function runRevenueRecognition[\s\S]{0,400}await assertEnabled\(db, orgId\)/,
    'recognition posting must refuse when Revenue Recognition is off — existing journals stay',
  )
  assert.match(
    read('../engine/src/project-revenue.ts'),
    /export async function syncProjectRevenueContracts[\s\S]{0,400}revenueRecognitionFeatureEnabled\(db, orgId\)/,
    'percent-complete sync must not write revenue contracts when Revenue Recognition is off',
  )
  assert.match(
    read('../engine/src/posting.ts'),
    /async function resolveDeferralAccounts[\s\S]{0,350}revenueRecognitionFeatureEnabled\(runner, orgId\)/,
    'invoice posting must credit income, not deferred, when Revenue Recognition is off',
  )
  assert.match(
    read('../engine/src/inventory.ts'),
    /export async function applyInventoryIssuesForInvoice[\s\S]{0,400}inventoryFeatureEnabled\(db, orgId\)/,
    'invoice posting must not mint inventory movements when Inventory is off — existing layers stay',
  )
  assert.match(
    read('../engine/src/inventory.ts'),
    /export async function applyInventoryReceiptsForBill[\s\S]{0,400}inventoryFeatureEnabled\(db, orgId\)/,
    'bill posting must not mint inventory receipts when Inventory is off — existing layers stay',
  )
  assert.match(
    read('../engine/src/inventory.ts'),
    /export async function resolveBillInventoryAccounts[\s\S]{0,350}inventoryFeatureEnabled\(runner, orgId\)/,
    'bill posting must debit the line account, not inventory, when Inventory is off',
  )
  assert.match(
    read('../engine/src/advanced-subscriptions.ts'),
    /export async function applyAmendment[\s\S]{0,200}await assertEnabled\(orgId\)/,
    'amendments and scheduled auto-renew must refuse when Advanced subscriptions is off — existing terms stay',
  )
  assert.match(
    read('../engine/src/advanced-subscriptions.ts'),
    /if \(!row\?\.billingTiming\) return true;\s*await assertEnabled\(orgId\)/,
    'scheduled billing may continue without a lifecycle; a lifecycle must not renew when Advanced subscriptions is off',
  )
  assert.match(
    read('lib/api/registry-data.ts'),
    /ITEM_REVENUE_RECOGNITION_COLUMNS/,
    'REST/MCP items catalog must name the revenue-recognition columns the Features switch hides',
  )
  assert.match(
    read('lib/api/schema-registry.ts'),
    /revenueRecognitionOn[\s\S]{0,200}ITEM_REVENUE_RECOGNITION_COLUMNS/,
    'REST/MCP items catalog must hide revenue-recognition columns when the feature is off',
  )
  assert.match(
    read('lib/api/writers.ts'),
    /refuseDisabledItemRevenueRecognition\(/,
    'REST/MCP item writes must refuse revenue-recognition columns when the feature is off',
  )
  assert.match(
    read('lib/api/registry-data.ts'),
    /ITEM_TIME_TRACKING_COLUMNS/,
    'REST/MCP items catalog must name the time-tracking columns the Features switch hides',
  )
  assert.match(
    read('lib/api/schema-registry.ts'),
    /timeTrackingOn[\s\S]{0,200}ITEM_TIME_TRACKING_COLUMNS/,
    'REST/MCP items catalog must hide show-on-timesheet when Time Tracking is off',
  )
  assert.match(
    read('lib/api/registry-data.ts'),
    /ITEM_INVENTORY_KINDS/,
    'REST/MCP items catalog must name the inventory kinds the Features switch hides',
  )
  assert.match(
    read('lib/api/schema-registry.ts'),
    /inventoryOn[\s\S]{0,250}ITEM_INVENTORY_KINDS/,
    'REST/MCP items catalog must hide inventory/assembly/kit kind values when Inventory is off',
  )
  assert.match(
    read('lib/api/registry-data.ts'),
    /ITEM_EQUIPMENT_KINDS/,
    'REST/MCP items catalog must name the equipment kinds the Features switch hides',
  )
  assert.match(
    read('lib/api/schema-registry.ts'),
    /equipmentOn[\s\S]{0,250}ITEM_EQUIPMENT_KINDS/,
    'REST/MCP items catalog must hide equipment_charge kind values when Equipment is off',
  )
  assert.match(
    read('lib/api/writers.ts'),
    /refuseDisabledItemTimeTracking\(/,
    'REST/MCP item writes must refuse show-on-timesheet when Time Tracking is off — existing flags stay',
  )
  assert.match(
    read('lib/api/writers.ts'),
    /async function refuseDisabledItemTimeTracking[\s\S]{0,350}err\(404/,
    'REST/MCP item writes must 404 — not persist — show-on-timesheet when Time Tracking is off',
  )
  assert.match(
    read('app/api/items/[id]/route.ts'),
    /isFeatureEnabled\(user\.orgId, 'revenueRecognition'\)/,
    'item catalog PATCH must refuse revenue-recognition fields when the feature is off',
  )
  assert.match(
    read('app/api/items/[id]/route.ts'),
    /isFeatureEnabled\(user\.orgId, 'timeTracking'\)/,
    'item catalog PATCH must refuse show-on-timesheet when Time Tracking is off — existing flags stay',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /orgFeatureEnabled\([^,]+, 'timeTracking'\)/,
    'items import must refuse show-on-timesheet when Time Tracking is off — existing flags stay',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /showOnTimesheet !== undefined/,
    'items import must refuse — not persist — show-on-timesheet when Time Tracking is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /orgFeatureEnabled\([^,]+, 'fixedAssets'\)/,
    'properties import must refuse fixedAsset when Fixed Assets is off — existing links stay',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /fixedAsset !== undefined/,
    'properties import must refuse — not persist — fixedAsset when Fixed Assets is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /propertyFields\([\s\S]{0,80}orgFeatureEnabled\([^,]+, 'multiCurrency'\)/,
    'properties import must refuse currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /!multiCurrencyOn && src\.currency !== undefined/,
    'properties import must refuse — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /multiCurrencyOn \|\| field\.key !== 'currency'/,
    'properties import must hide currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/items/[id]/route.ts'),
    /status: 404/,
    'item catalog PATCH must 404 — not persist — revenue-recognition fields when the feature is off',
  )
  assert.match(
    read('app/(app)/items/ItemDrawer.tsx'),
    /timeTracking \? \{ showOnTimesheet \}/,
    'the item drawer must not send show-on-timesheet when Time Tracking is off',
  )
  assert.match(
    read('app/(app)/items/ItemDrawer.tsx'),
    /\{timeTracking \? \(/,
    'the item drawer must hide show-on-timesheet when Time Tracking is off',
  )
  assert.match(
    read('app/api/items/[id]/route.ts'),
    /kind !== undefined[\s\S]{0,80}inventory/,
    'item catalog PATCH must refuse inventory kinds when Inventory is off — existing kinds stay',
  )
  assert.match(
    read('app/api/items/[id]/route.ts'),
    /INVENTORY_ITEM_KINDS[\s\S]{0,200}status: 404/,
    'item catalog PATCH must 404 — not persist — inventory kinds when Inventory is off',
  )
  assert.match(
    read('app/api/items/[id]/route.ts'),
    /kind !== undefined[\s\S]{0,80}equipment/,
    'item catalog PATCH must refuse equipment_charge when Equipment is off — existing kinds stay',
  )
  assert.match(
    read('app/api/items/[id]/route.ts'),
    /nextKind === 'equipment_charge'[\s\S]{0,200}status: 404/,
    'item catalog PATCH must 404 — not persist — equipment_charge when Equipment is off',
  )
  assert.match(
    read('app/(app)/items/ItemDrawer.tsx'),
    /equipmentEnabled \|\| kind !== 'equipment_charge'/,
    'the item drawer must not send equipment_charge when Equipment is off',
  )
  assert.match(
    read('app/(app)/items/ItemDrawer.tsx'),
    /equipmentEnabled \|\| k !== 'equipment_charge'/,
    'the item drawer must hide equipment_charge when Equipment is off',
  )
  assert.match(
    read('app/(app)/items/page.tsx'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'the items page must read the Equipment switch before offering equipment_charge',
  )
  assert.match(
    read('app/(app)/items/ItemDrawer.tsx'),
    /inventoryCosting \|\| !INVENTORY_KINDS\.has\(kind\)/,
    'the item drawer must not send inventory kinds when Inventory is off',
  )
  assert.match(
    read('app/(app)/items/ItemDrawer.tsx'),
    /inventoryCosting \|\| !INVENTORY_KINDS\.has\(k\)/,
    'the item drawer must hide inventory kinds when Inventory is off',
  )
  assert.match(
    read('lib/api/writers.ts'),
    /refuseDisabledItemInventoryKind\(/,
    'REST/MCP item writes must refuse inventory kinds when Inventory is off — existing kinds stay',
  )
  assert.match(
    read('lib/api/writers.ts'),
    /async function refuseDisabledItemInventoryKind[\s\S]{0,500}err\(404/,
    'REST/MCP item writes must 404 — not persist — inventory kinds when Inventory is off',
  )
  assert.match(
    read('lib/api/writers.ts'),
    /refuseDisabledItemEquipmentKind\(/,
    'REST/MCP item writes must refuse equipment_charge when Equipment is off — existing kinds stay',
  )
  assert.match(
    read('lib/api/writers.ts'),
    /async function refuseDisabledItemEquipmentKind[\s\S]{0,500}err\(404/,
    'REST/MCP item writes must 404 — not persist — equipment_charge when Equipment is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /orgFeatureEnabled\([^,]+, 'inventory'\)/,
    'items import must refuse inventory kinds when Inventory is off — existing kinds stay',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /INVENTORY_ITEM_KINDS\.has\(nextKind\)[\s\S]{0,400}kind is not available/,
    'items import must refuse — not persist — new inventory/assembly/kit kinds when Inventory is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /c\.key === 'kind' && !inventoryOn[\s\S]{0,80}INVENTORY_ITEM_KINDS\.has\(o\.value\)/,
    'items import must hide inventory/assembly/kit kind values when Inventory is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /orgFeatureEnabled\([^,]+, 'equipment'\)/,
    'items import must refuse equipment_charge when Equipment is off — existing kinds stay',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /ITEM_EQUIPMENT_KINDS\.has\(nextKind\)[\s\S]{0,400}kind is not available/,
    'items import must refuse — not persist — new equipment_charge kinds when Equipment is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /c\.key === 'kind' && !equipmentOn[\s\S]{0,80}ITEM_EQUIPMENT_KINDS\.has\(o\.value\)/,
    'items import must hide equipment_charge kind values when Equipment is off',
  )
  assert.match(
    read('app/api/equipment/[id]/capitalize/route.ts'),
    /isFeatureEnabled\([^,]+, 'fixedAssets'\)/,
    'equipment capitalize must not write fixed-asset rows when Fixed Assets is off — existing units stay',
  )
  assert.match(
    read('app/api/equipment/[id]/capitalize/route.ts'),
    /status: 404/,
    'equipment capitalize must 404 — not mint a fixed asset — when Fixed Assets is off',
  )
  assert.match(
    read('app/api/equipment/[id]/route.ts'),
    /isFeatureEnabled\([^,]+, 'fixedAssets'\)/,
    'equipment PATCH must not change the fixed-asset link when Fixed Assets is off — existing links stay',
  )
  assert.match(
    read('app/(app)/assets/equipment/EquipmentDrawer.tsx'),
    /fixedAssetsEnabled && !e\.fixed_asset_id/,
    'equipment drawer must hide capitalize when Fixed Assets is off',
  )
  assert.match(
    read('app/(app)/assets/equipment/page.tsx'),
    /isFeatureEnabled\([^,]+, 'fixedAssets'\)/,
    'equipment page must hide Fixed Assets links when the switch is off',
  )
  assert.match(
    read('lib/field-tickets.ts'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'field-ticket lines must not store equipment_unit_id when Equipment is off — existing links stay',
  )
  assert.match(
    read('app/api/field-tickets/[id]/route.ts'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'field-ticket add-line must 404 — not persist equipment_unit_id — when Equipment is off',
  )
  assert.match(
    read('lib/field-ticket-drawer-data.ts'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'field-ticket catalog picker must read the Equipment switch before offering equipment_charge',
  )
  assert.match(
    read('lib/field-ticket-drawer-data.ts'),
    /equipmentEnabled \? \['equipment_charge'\]/,
    'field-ticket catalog picker must drop equipment_charge when Equipment is off — stored tickets stay',
  )
  assert.match(
    read('lib/field-ticket-drawer-data.ts'),
    /isFeatureEnabled\([^,]+, 'inventory'\)/,
    'field-ticket catalog picker must read the Inventory switch before offering inventory items',
  )
  assert.match(
    read('lib/field-ticket-drawer-data.ts'),
    /inventoryEnabled \? \['inventory'\]/,
    'field-ticket catalog picker must drop inventory when Inventory is off — stored tickets stay',
  )
  assert.match(
    read('lib/field-tickets.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'field-ticket add-line must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('lib/field-tickets.ts'),
    /INVENTORY_ITEM_KINDS\.has\([^)]+\)[\s\S]{0,80}isFeatureEnabled\([^,]+, 'inventory'\)/,
    'field-ticket lines must not store inventory/assembly/kit items when Inventory is off — existing lines stay',
  )
  assert.match(
    read('app/api/field-tickets/[id]/route.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'field-ticket add-line API must name the inventory kinds the Features switch 404s',
  )
  assert.match(
    read('app/api/field-tickets/[id]/route.ts'),
    /INVENTORY_ITEM_KINDS[\s\S]{0,200}status: 404/,
    'field-ticket add-line must 404 — not persist inventory/assembly/kit items — when Inventory is off',
  )
  assert.match(
    read('lib/field-tickets.ts'),
    /kind === 'equipment_charge'[\s\S]{0,80}isFeatureEnabled\([^,]+, 'equipment'\)/,
    'field-ticket lines must not store equipment_charge items when Equipment is off — existing lines stay',
  )
  assert.match(
    read('app/api/field-tickets/[id]/route.ts'),
    /kind === 'equipment_charge'[\s\S]{0,200}status: 404/,
    'field-ticket add-line must 404 — not persist equipment_charge items — when Equipment is off',
  )
  assert.match(
    read('app/api/field-tickets/item-rate/route.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'field-ticket item-rate preview must name the inventory kinds the Features switch 404s',
  )
  assert.match(
    read('app/api/field-tickets/item-rate/route.ts'),
    /INVENTORY_ITEM_KINDS[\s\S]{0,200}isFeatureEnabled\([^,]+, 'inventory'\)[\s\S]{0,160}status: 404/,
    'field-ticket item-rate preview must 404 inventory/assembly/kit when Inventory is off — stored tickets stay',
  )
  assert.match(
    read('app/api/field-tickets/item-rate/route.ts'),
    /kind === 'equipment_charge'[\s\S]{0,200}isFeatureEnabled\([^,]+, 'equipment'\)[\s\S]{0,160}status: 404/,
    'field-ticket item-rate preview must 404 equipment_charge when Equipment is off — stored tickets stay',
  )
  assert.match(
    read('app/(app)/items/page.tsx'),
    /revenueRecognitionEnabled\s*\?\s*[\s\S]{0,160}recognition_rules/,
    'the items page must not load recognition rules when Revenue Recognition is off',
  )
  assert.match(
    read('app/(app)/items/ItemDrawer.tsx'),
    /fairValuePrices[\s\S]{0,120}recognitionRuleId/,
    'the item drawer must not send revenue-recognition fields when Revenue Recognition is off',
  )
  assert.match(
    read('app/(app)/items/ItemDrawer.tsx'),
    /\{fairValuePrices \? <section/,
    'the item drawer must hide the revenue-recognition section when the feature is off',
  )
  assert.match(
    read('lib/project-charges.ts'),
    /isFeatureEnabled\(orgId, 'equipment'\)/,
    'project-charge lines must not store equipment_unit_id when Equipment is off — existing charges stay',
  )
  assert.match(
    read('app/api/project-charges/route.ts'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'project-charge POST must refuse equipment_unit_id when Equipment is off',
  )
  assert.match(
    read('app/api/project-charges/route.ts'),
    /status: 404/,
    'project-charge POST must 404 — not persist — equipment_unit_id when Equipment is off',
  )
  assert.match(
    read('lib/project-charges.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'project-charge writes must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('lib/project-charges.ts'),
    /INVENTORY_ITEM_KINDS\.has\([^)]+\)[\s\S]{0,80}!inventoryOn/,
    'project-charge lines must not store inventory/assembly/kit items when Inventory is off — existing charges stay',
  )
  assert.match(
    read('app/api/project-charges/route.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,200}status: 404/,
    'project-charge POST must 404 — not persist inventory/assembly/kit items — when Inventory is off',
  )
  assert.match(
    read('lib/project-charges.ts'),
    /kind\) === 'equipment_charge'[\s\S]{0,80}!equipmentOn/,
    'project-charge lines must not store equipment_charge items when Equipment is off — existing charges stay',
  )
  assert.match(
    read('app/api/project-charges/route.ts'),
    /kind === 'equipment_charge'[\s\S]{0,200}status: 404/,
    'project-charge POST must 404 — not persist equipment_charge items — when Equipment is off',
  )
  assert.match(
    read('app/(app)/projects/_cockpit-data.ts'),
    /isFeatureEnabled\([^,]+, 'inventory'\)/,
    'project cockpit must not offer inventory/assembly/kit items when Inventory is off',
  )
  assert.match(
    read('app/(app)/projects/_cockpit-data.ts'),
    /kind not in \('inventory', 'assembly', 'kit'\)/,
    'project charge picker must drop inventory/assembly/kit when Inventory is off — stored charges stay',
  )
  assert.match(
    read('app/(app)/projects/_cockpit-data.ts'),
    /kind <> 'equipment_charge'/,
    'project charge picker must drop equipment_charge when Equipment is off — stored charges stay',
  )
  assert.match(
    read('app/(app)/projects/tabs/ChargesSection.tsx'),
    /equipmentEnabled \? \{[\s\S]{0,80}equipmentUnitId/,
    'the charge form must not send equipment_unit_id when Equipment is off',
  )
  assert.match(
    read('app/(app)/projects/tabs/ChargesSection.tsx'),
    /\{equipmentEnabled \? \(/,
    'the charge form must hide the equipment picker when Equipment is off',
  )
  assert.match(
    read('app/(app)/projects/_cockpit-data.ts'),
    /isFeatureEnabled\(orgId, 'equipment'\)/,
    'project cockpit must not load equipment pickers when Equipment is off',
  )
  assert.match(
    read('lib/setup/registry.ts'),
    /key === 'equipmentUnitId'[\s\S]{0,40}ref === 'equipment-units'/,
    'derived-rule setup must hide equipmentUnitId when Equipment is off',
  )
  assert.match(
    read('lib/setup/registry.ts'),
    /option\.value !== 'equipment_charge'/,
    'derived-rule setup must hide the equipment_charge trigger when Equipment is off',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'derived-rule setup must not persist equipment_unit_id when Equipment is off — existing rules stay',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /pay-derived-rules[\s\S]{0,900}return 'not found'/,
    'derived-rule setup must 404 — not persist — equipment_unit_id / equipment_charge when Equipment is off',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /integrityError === 'not found' \? 404/,
    'derived-rule setup POST must 404 — not persist — equipment_unit_id when Equipment is off',
  )
  assert.match(
    read('app/(app)/admin/setup/[entity]/SetupEntitySection.tsx'),
    /equipment: await isFeatureEnabled\(orgId, 'equipment'\)/,
    'derived-rule setup must hide the equipment picker when Equipment is off',
  )
  assert.match(
    read('lib/setup/registry.ts'),
    /control\.key === 'showOnFieldTicket'/,
    'time-type setup must hide showOnFieldTicket when Field Tickets is off',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /time-types[\s\S]{0,200}showOnFieldTicket[\s\S]{0,120}fieldTickets/,
    'time-type setup must not persist showOnFieldTicket when Field Tickets is off — existing flags stay',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /entity\.key === 'time-types'[\s\S]{0,160}return 'not found'/,
    'time-type setup must 404 — not persist — showOnFieldTicket when Field Tickets is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /showOnFieldTicket is not available/,
    'time-type import must refuse showOnFieldTicket when Field Tickets is off — existing flags stay',
  )
  assert.match(
    read('app/api/equipment/[id]/route.ts'),
    /isFeatureEnabled\([^,]+, 'projects'\)/,
    'equipment PATCH must not change the rate-book link when Projects is off — existing links stay',
  )
  assert.match(
    read('app/(app)/assets/equipment/EquipmentDrawer.tsx'),
    /projectsEnabled \? \{ rateBookId/,
    'equipment drawer must not send rateBookId when Projects is off',
  )
  assert.match(
    read('app/(app)/assets/equipment/EquipmentDrawer.tsx'),
    /\{projectsEnabled \? \(/,
    'equipment drawer must hide the rate-book picker when Projects is off',
  )
  assert.match(
    read('app/(app)/assets/equipment/page.tsx'),
    /isFeatureEnabled\([^,]+, 'projects'\)/,
    'equipment page must hide rate books when Projects is off',
  )
  assert.match(
    read('../engine/src/sync/netsuite-fixed-assets.ts'),
    /coalesce\(\(settings->'features'->>'fixedAssets'\)::boolean, true\)/,
    'NetSuite FAM sync must not write fixed assets when the Fixed Assets switch is off — existing register stays',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /coalesce\(\(settings->'features'->>'fixedAssets'\)::boolean, true\)/,
    'property writes must not store fixed_asset_id when Fixed Assets is off — existing links stay',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /input\.fixedAssetId && !\(await fixedAssetsFeatureEnabled[\s\S]{0,120}Fixed assets feature is disabled/,
    'property create must refuse a new fixed-asset link when Fixed Assets is off',
  )
  assert.match(
    read('app/api/property-management/route.ts'),
    /isFeatureEnabled\([^,]+, ["']fixedAssets["']\)/,
    'property create/update must refuse fixedAssetId when Fixed Assets is off — existing links stay',
  )
  assert.match(
    read('app/api/property-management/route.ts'),
    /refuseDisabledPropertyFixedAsset[\s\S]{0,900}status: 404/,
    'property create/update must 404 — not persist — fixedAssetId when Fixed Assets is off',
  )
  assert.match(
    read('app/(app)/property-management/page.tsx'),
    /isFeatureEnabled\([^,]+, ["']fixedAssets["']\)/,
    'property management must not load the asset picker when Fixed Assets is off',
  )
  assert.match(
    read('app/(app)/property-management/PropertyDetailDrawer.tsx'),
    /fixedAssetsEnabled \? \{[\s\S]{0,80}fixedAssetId/,
    'the property form must not send fixedAssetId when Fixed Assets is off',
  )
  assert.match(
    read('app/(app)/property-management/PropertyDrawer.tsx'),
    /\{fixedAssetsEnabled \? <Field label="Fixed asset">/,
    'the property form must hide the fixed-asset picker when Fixed Assets is off',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /coalesce\(\(settings->'features'->>'multiCurrency'\)::boolean, false\)/,
    'property writes must not store a caller currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /PropertyManagementError\("Multi-currency is disabled", 404\)/,
    'property create/update must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/property-management/route.ts'),
    /body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'property create/update must refuse currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('app/api/property-management/route.ts'),
    /body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'property create/update must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/property-management/page.tsx'),
    /isFeatureEnabled\([^,]+, ["']multiCurrency["']\)/,
    'property management must not load the currency picker when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/property-management/PropertyDrawer.tsx'),
    /multiCurrency \? \{[\s\S]{0,80}currency/,
    'the property form must not send currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/property-management/PropertyDetailDrawer.tsx'),
    /case "currency":\s*if \(!multiCurrency\) return null/,
    'the property form must hide the currency control when Multi-currency is off',
  )
  assert.match(
    read('app/api/property-management/route.ts'),
    /\["inventory", "assembly", "kit"\]/,
    'lease-charge writes must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('app/api/property-management/route.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'lease-charge addCharge must 404 — not persist inventory/assembly/kit items — when Inventory is off — stored charges stay',
  )
  assert.match(
    read('app/(app)/property-management/LeaseSections.tsx'),
    /incomeAccountId: "",\s*taxCodeId: "",/,
    'the lease-charge form must not send itemId — stored charges stay',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /leaseChargeFields\(await orgFeatureEnabled\([^,]+, 'inventory'\)\)/,
    'lease-charge import must refuse inventory/assembly/kit items when Inventory is off — stored charges stay',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,80}item is not available/,
    'lease-charge import must refuse — not persist — inventory/assembly/kit items when Inventory is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /field\.key !== 'item'/,
    'lease-charge import must hide item when Inventory is off',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /\["inventory", "assembly", "kit"\]/,
    'lease escalation must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /INVENTORY_ITEM_KINDS\.has\([^)]+\)[\s\S]{0,80}Inventory is disabled/,
    'applyLeaseEscalation must not persist inventory/assembly/kit items when Inventory is off — stored charges and scheduled escalations stay',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /PropertyManagementError\("Inventory is disabled", 404\)/,
    'applyLeaseEscalation must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /kind === "equipment_charge"[\s\S]{0,80}Equipment is disabled/,
    'applyLeaseEscalation must not persist equipment_charge items when Equipment is off — stored charges and scheduled escalations stay',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /PropertyManagementError\("Equipment is disabled", 404\)/,
    'applyLeaseEscalation must 404 — not persist equipment_charge — when Equipment is off',
  )
  assert.match(
    read('app/api/property-management/route.ts'),
    /error instanceof PropertyManagementError[\s\S]{0,120}status: error\.status/,
    'lease apply-escalation must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /export async function billDueLeaseCharges[\s\S]{0,4000}INVENTORY_ITEM_KINDS\.has/,
    'billDueLeaseCharges must not persist inventory/assembly/kit items when Inventory is off — stored schedule lines and existing invoices stay',
  )
  assert.match(
    read('../engine/src/property-management.ts'),
    /if \(!invoiceId\) \{[\s\S]{0,800}Inventory is disabled/,
    'billDueLeaseCharges must 404 — not persist inventory/assembly/kit — when Inventory is off',
  )
  assert.match(
    read('app/api/admin/settings/route.ts'),
    /isFeatureEnabled\([^,]+, ["']revenueRecognition["']\)/,
    'company settings must refuse fairValueRangePolicy when Revenue Recognition is off — existing policy stays',
  )
  assert.match(
    read('app/api/admin/settings/route.ts'),
    /fairValueRangePolicy !== undefined[\s\S]{0,280}status: 404/,
    'company settings must 404 — not persist — fairValueRangePolicy when Revenue Recognition is off',
  )
  assert.match(
    read('app/(app)/admin/setup/[entity]/CompanyTab.tsx'),
    /isFeatureEnabled\([^,]+, ["']revenueRecognition["']\)/,
    'company settings must not load the fair-value policy control when Revenue Recognition is off',
  )
  assert.match(
    read('app/(app)/admin/settings/SettingsForm.tsx'),
    /revenueRecognition \? \{ \.\.\.rest, fairValueRangePolicy \}/,
    'the company form must not send fairValueRangePolicy when Revenue Recognition is off',
  )
  assert.match(
    read('app/(app)/admin/settings/SettingsForm.tsx'),
    /\{revenueRecognition \? <Card>/,
    'the company form must hide the fair-value range policy when Revenue Recognition is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /orgFeatureEnabled\([^,]+, 'multiCurrency'\)/,
    'accounts import must refuse currencyRestriction when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /currencyRestriction !== undefined/,
    'accounts import must refuse — not persist — currencyRestriction when Multi-currency is off',
  )
  assert.match(
    read('app/api/accounts/[id]/route.ts'),
    /isFeatureEnabled\([^,]+, 'multiCurrency'\)/,
    'account PATCH must refuse currencyRestriction when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('app/api/accounts/[id]/route.ts'),
    /currencyRestriction !== undefined[\s\S]{0,200}status: 404/,
    'account PATCH must 404 — not persist — currencyRestriction when Multi-currency is off',
  )
  assert.match(
    read('app/api/accounts/route.ts'),
    /isFeatureEnabled\([^,]+, 'multiCurrency'\)/,
    'account POST must refuse currencyRestriction when Multi-currency is off',
  )
  assert.match(
    read('app/api/accounts/route.ts'),
    /currencyRestriction !== undefined[\s\S]{0,200}status: 404/,
    'account POST must 404 — not persist — currencyRestriction when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/accounts/AccountDrawer.tsx'),
    /multiCurrency \? \{ currencyRestriction/,
    'the account drawer must not send currencyRestriction when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/accounts/AccountDrawer.tsx'),
    /\{multiCurrency \? \(/,
    'the account drawer must hide currencyRestriction when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/accounts/page.tsx'),
    /isFeatureEnabled\([^,]+, 'multiCurrency'\)/,
    'the accounts page must not load currency pickers when Multi-currency is off',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /src\.currency !== undefined/,
    'transaction import must refuse currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('lib/data-io/resources.ts'),
    /f\.key !== 'currency'/,
    'transaction import must hide currency when Multi-currency is off',
  )
  assert.match(
    read('lib/documents.ts'),
    /isFeatureEnabled\([^,]+, 'multiCurrency'\)/,
    'document PATCH must refuse currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('lib/documents.ts'),
    /currency !== undefined[\s\S]{0,200}DocumentEditError\(404/,
    'document PATCH must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('lib/documents.ts'),
    /currency !== undefined \? currency : sql`currency`/,
    'document PATCH must keep the stored currency when Multi-currency is off and the field is omitted',
  )
  assert.match(
    read('lib/api/writers.ts'),
    /isFeatureEnabled\([^,]+, ["']multiCurrency["']\)/,
    'document create/PATCH must refuse currency when Multi-currency is off',
  )
  assert.match(
    read('lib/api/writers.ts'),
    /currency !== undefined[\s\S]{0,200}err\(404/,
    'document create/PATCH must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('lib/api/schema-registry.ts'),
    /multiCurrencyOn \|\| t\.table !== "documents" \|\| c\.column_name !== "currency"/,
    'REST/MCP documents catalog must not advertise currency as writable when Multi-currency is off',
  )
  assert.match(
    read('app/api/parties/[id]/route.ts'),
    /workerCompGroupId !== undefined[\s\S]{0,200}payroll/,
    'employee party writes must refuse workerCompGroupId when Payroll is off — existing links stay',
  )
  assert.match(
    read('app/api/parties/[id]/route.ts'),
    /workerCompGroupId !== undefined[\s\S]{0,280}status: 404/,
    'employee party writes must 404 — not persist — workerCompGroupId when Payroll is off',
  )
  assert.match(
    read('app/api/parties/[id]/route.ts'),
    /employee_roles\.worker_comp_group_id/,
    'employee party writes must keep the stored worker-comp link when Payroll is off',
  )
  assert.match(
    read('app/(app)/parties/page.tsx'),
    /isFeatureEnabled\([^,]+, ["']payroll["']\)/,
    'the parties page must not load the worker-comp picker when Payroll is off',
  )
  assert.match(
    read('app/(app)/entities/[role]/page.tsx'),
    /payrollEnabled[\s\S]{0,80}worker_comp_groups/,
    'entities must not load the worker-comp picker when Payroll is off',
  )
  assert.match(
    read('app/api/parties/[id]/drawer/route.ts'),
    /isFeatureEnabled\([^,]+, ["']payroll["']\)/,
    'the related-party drawer must not load the worker-comp picker when Payroll is off',
  )
  assert.match(
    read('app/(app)/parties/PartyDrawer.tsx'),
    /payrollEnabled \? \{[\s\S]{0,80}workerCompGroupId/,
    'the party form must not send workerCompGroupId when Payroll is off',
  )
  assert.match(
    read('app/(app)/parties/PartyDrawer.tsx'),
    /\{payrollEnabled \? <div className=\{field\}>/,
    'the party form must hide the worker-comp picker when Payroll is off',
  )
  assert.match(
    read('app/api/accounts/[id]/route.ts'),
    /subsidiaryFeatureEnabled\(/,
    'account PATCH must refuse eliminate when Multi-subsidiary is off — existing flags stay',
  )
  assert.match(
    read('app/api/accounts/[id]/route.ts'),
    /eliminate !== undefined[\s\S]{0,200}status: 404/,
    'account PATCH must 404 — not persist — eliminate when Multi-subsidiary is off',
  )
  assert.match(
    read('app/api/accounts/route.ts'),
    /subsidiaryFeatureEnabled\(/,
    'account POST must refuse eliminate when Multi-subsidiary is off',
  )
  assert.match(
    read('app/api/accounts/route.ts'),
    /eliminate !== undefined[\s\S]{0,200}status: 404/,
    'account POST must 404 — not persist — eliminate when Multi-subsidiary is off',
  )
  assert.match(
    read('app/(app)/accounts/AccountDrawer.tsx'),
    /multiSubsidiary \? \{ eliminate \}/,
    'the account drawer must not send eliminate when Multi-subsidiary is off',
  )
  assert.match(
    read('app/(app)/accounts/AccountDrawer.tsx'),
    /\{multiSubsidiary \? <label/,
    'the account drawer must hide eliminate when Multi-subsidiary is off',
  )
  assert.match(
    read('app/(app)/accounts/page.tsx'),
    /multiSubsidiary=\{subsidiaryUiEnabled\}/,
    'the accounts page must not load the eliminate control when Multi-subsidiary is off',
  )
  assert.match(
    read('app/api/crm/opportunities/[id]/route.ts'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'opportunity PATCH must refuse currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('app/api/crm/opportunities/[id]/route.ts'),
    /currency !== undefined[\s\S]{0,200}status: 404/,
    'opportunity PATCH must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/crm/opportunities/[id]/route.ts'),
    /body\.currency === undefined \? current\.currency/,
    'opportunity PATCH must keep the stored currency when Multi-currency is off and the field is omitted',
  )
  assert.match(
    read('app/api/crm/opportunities/[id]/route.ts'),
    /\['inventory', 'assembly', 'kit'\]/,
    'opportunity line writes must name the inventory kinds the Features switch refuses',
  )
  assert.match(
    read('app/api/crm/opportunities/[id]/route.ts'),
    /storedIds\.has\(line\.itemId\)/,
    'opportunity PATCH must keep stored inventory lines when Inventory is off',
  )
  assert.match(
    read('app/api/crm/opportunities/[id]/route.ts'),
    /INVENTORY_ITEM_KINDS\.has[\s\S]{0,160}status: 404/,
    'opportunity PATCH must 404 — not persist new inventory/assembly/kit lines — when Inventory is off',
  )
  assert.match(
    read('app/api/crm/opportunities/[id]/route.ts'),
    /isFeatureEnabled\([^,]+, 'equipment'\)/,
    'opportunity PATCH must refuse equipment_charge when Equipment is off — stored lines stay',
  )
  assert.match(
    read('app/api/crm/opportunities/[id]/route.ts'),
    /kind === 'equipment_charge'[\s\S]{0,200}status: 404/,
    'opportunity PATCH must 404 — not persist equipment_charge lines — when Equipment is off',
  )
  assert.match(
    read('app/(app)/crm/opportunities/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]inventory['"]\)/,
    'the opportunities page must not offer inventory/assembly/kit items when Inventory is off',
  )
  assert.match(
    read('app/(app)/crm/opportunities/page.tsx'),
    /kind not in \('inventory', 'assembly', 'kit'\)/,
    'the opportunity item picker must drop inventory/assembly/kit when Inventory is off — stored lines stay',
  )
  assert.match(
    read('app/(app)/crm/opportunities/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]equipment['"]\)/,
    'the opportunities page must not offer equipment_charge items when Equipment is off',
  )
  assert.match(
    read('app/(app)/crm/opportunities/page.tsx'),
    /kind <> 'equipment_charge'/,
    'the opportunity item picker must drop equipment_charge when Equipment is off — stored lines stay',
  )
  assert.match(
    read('app/(app)/crm/opportunities/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'the opportunities page must not load the currency picker when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/crm/OpportunityDrawer.tsx'),
    /multiCurrency \? \{[\s\S]{0,80}currency/,
    'the opportunity form must not send currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/crm/OpportunityDrawer.tsx'),
    /\{multiCurrency \? <Field label=\{t\('fields\.currency'\)\}>/,
    'the opportunity form must hide the currency picker when Multi-currency is off',
  )
  assert.match(
    read('app/api/parties/[id]/route.ts'),
    /customer\?\.currency !== undefined[\s\S]{0,80}vendor\?\.currency !== undefined[\s\S]{0,120}multiCurrency/,
    'customer/vendor party writes must refuse currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('app/api/parties/[id]/route.ts'),
    /customer\?\.currency !== undefined[\s\S]{0,200}status: 404/,
    'customer/vendor party writes must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/parties/[id]/route.ts'),
    /currency !== undefined \? currency : sql`customer_roles\.currency`/,
    'customer party writes must keep the stored currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/parties/[id]/route.ts'),
    /currency !== undefined \? currency : sql`vendor_roles\.currency`/,
    'vendor party writes must keep the stored currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/parties/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'the parties page must not load the currency control when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/entities/[role]/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'entities must not load the currency control when Multi-currency is off',
  )
  assert.match(
    read('app/api/parties/[id]/drawer/route.ts'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'the related-party drawer must not load the currency control when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/parties/PartyDrawer.tsx'),
    /multiCurrency \? \{[\s\S]{0,80}currency/,
    'the party form must not send currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/parties/PartyDrawer.tsx'),
    /\{multiCurrency \? <div className=\{field\}>/,
    'the party form must hide the currency picker when Multi-currency is off',
  )
  assert.match(
    read('app/api/crm/setup/route.ts'),
    /body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'CRM quota writes must refuse currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('app/api/crm/setup/route.ts'),
    /body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'CRM quota writes must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/crm/setup/route.ts'),
    /currency !== undefined \? currency : sql`crm_sales_quotas\.currency`/,
    'CRM quota writes must keep the stored currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/admin/setup/crm/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'CRM setup must not load the quota currency picker when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/admin/setup/crm/CrmSetupWorkspace.tsx'),
    /multiCurrency \? \{[\s\S]{0,80}currency/,
    'the quota form must not send currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/admin/setup/crm/CrmSetupWorkspace.tsx'),
    /\{multiCurrency \? \(/,
    'the quota form must hide the currency picker when Multi-currency is off',
  )
  assert.match(
    read('app/api/subscriptions/route.ts'),
    /body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'subscription plan writes must refuse currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('app/api/subscriptions/route.ts'),
    /body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'subscription plan writes must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/subscriptions/route.ts'),
    /currency !== undefined \? body\.currency : sql`currency_code`/,
    'subscription plan writes must keep the stored currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/subscriptions/advanced/route.ts'),
    /body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'subscription plan-version writes must refuse currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('app/api/subscriptions/advanced/route.ts'),
    /body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'subscription plan-version writes must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/subscriptions/advanced/route.ts'),
    /body\.currency === undefined \? undefined/,
    'subscription plan-version writes must keep the stored currency when Multi-currency is off and the field is omitted',
  )
  assert.match(
    read('app/api/subcontracts/route.ts'),
    /body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'subcontract create must refuse currency when Multi-currency is off — existing values stay',
  )
  assert.match(
    read('app/api/subcontracts/route.ts'),
    /body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'subcontract create must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/subcontracts/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'the subcontracts page must not load the currency picker when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/subcontracts/SubcontractsWorkspace.tsx'),
    /multiCurrency \? \{[\s\S]{0,80}currency/,
    'the subcontract form must not send currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/subcontracts/SubcontractsWorkspace.tsx'),
    /\{multiCurrency \? <Field label="Currency">/,
    'the subcontract form must hide the currency picker when Multi-currency is off',
  )
  assert.match(
    read('app/api/labor-rate-cards/route.ts'),
    /body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'labor-rate-card create must refuse currency when Multi-currency is off — stored books stay',
  )
  assert.match(
    read('app/api/labor-rate-cards/route.ts'),
    /body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'labor-rate-card create must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/labor-rate-cards/route.ts'),
    /body\.currency !== undefined\s*\?\s*String\(body\.currency\)[\s\S]{0,80}base_currency/,
    'labor-rate-card create must fall back to the org base currency when currency is omitted',
  )
  assert.match(
    read('app/(app)/admin/setup/labor-pricing/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'labor pricing must not load the create-card currency control when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/admin/setup/labor-costing/LaborBillRateCards.tsx'),
    /multiCurrency \? \{[\s\S]{0,80}currency/,
    'the labor-rate-card create must not send currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/labor-rate-cards/[id]/route.ts'),
    /body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'labor-rate-card update must refuse currency when Multi-currency is off — stored books stay',
  )
  assert.match(
    read('app/api/labor-rate-cards/[id]/route.ts'),
    /body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'labor-rate-card update must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/labor-rate-cards/[id]/route.ts'),
    /currency = case when \$\{body\.currency === undefined\} then currency/,
    'labor-rate-card update must keep the stored currency when Multi-currency is off and the field is omitted',
  )
  assert.match(
    read('app/(app)/admin/setup/labor-costing/LaborBillRateCards.tsx'),
    /\/api\/labor-rate-cards\/\$\{card\.id\}[\s\S]{0,240}multiCurrency \? \{[\s\S]{0,80}currency/,
    'the labor-rate-card edit must not send currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/admin/setup/labor-costing/LaborBillRateCards.tsx'),
    /placement\.key === "currency"[\s\S]{0,80}!props\.multiCurrency/,
    'the labor-rate-card form must hide the currency control when Multi-currency is off',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /entity\.key === 'item-rate-books'[\s\S]{0,400}body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'item-rate-book create must refuse currency when Multi-currency is off — stored books stay',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /entity\.key === 'item-rate-books'[\s\S]{0,400}body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'item-rate-book create must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /body\.currency !== undefined\s*\?\s*String\(body\.currency\)[\s\S]{0,80}base_currency/,
    'item-rate-book create must fall back to the org base currency when currency is omitted',
  )
  assert.match(
    read('app/(app)/admin/setup/[entity]/SetupEntitySection.tsx'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'setup must not load the item-rate-book currency control when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/admin/setup/[entity]/SetupEntitySection.tsx'),
    /item-rate-books[\s\S]{0,200}!multiCurrency[\s\S]{0,160}field\.key !== 'currency'/,
    'the item-rate-book form must hide the currency control when Multi-currency is off',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /entity\.key === 'item-rate-books'[\s\S]{0,400}body\.currency !== undefined[\s\S]{0,80}multiCurrency[\s\S]{0,600}for update/,
    'item-rate-book UPDATE must refuse currency when Multi-currency is off — stored books stay',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /entity\.key === 'item-rate-books'[\s\S]{0,400}body\.currency !== undefined[\s\S]{0,200}status: 404[\s\S]{0,600}for update/,
    'item-rate-book UPDATE must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/admin/setup/[entity]/route.ts'),
    /currency = case when \$\{body\.currency === undefined\} then currency/,
    'item-rate-book UPDATE must keep the stored currency when Multi-currency is off and the field is omitted',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/route.ts'),
    /body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'payment-format create must refuse currency when Multi-currency is off — stored formats stay',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/route.ts'),
    /body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'payment-format create must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/route.ts'),
    /currency: body\.currency !== undefined \?[\s\S]{0,80}null/,
    'payment-format create must keep a null currency when the field is omitted',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/[id]/route.ts'),
    /resource === 'formats'[\s\S]{0,400}body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'payment-format PATCH must refuse currency when Multi-currency is off — stored formats stay',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/[id]/route.ts'),
    /resource === 'formats'[\s\S]{0,500}body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'payment-format PATCH must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/[id]/route.ts'),
    /currency = case when \$\{body\.currency === undefined\} then currency/,
    'payment-format PATCH must keep the stored currency when Multi-currency is off and the field is omitted',
  )
  assert.match(
    read('app/(app)/admin/setup/payment-operations/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'payment operations must not load the format currency control when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/admin/setup/payment-operations/PaymentOperationsSetup.tsx'),
    /multiCurrency \? \{[\s\S]{0,80}currency/,
    'the payment-format form must not send currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/admin/setup/payment-operations/PaymentOperationsSetup.tsx'),
    /\{multiCurrency \? <CurrencyField/,
    'the payment-format form must hide the currency picker when Multi-currency is off',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/[id]/route.ts'),
    /resource === 'profiles'[\s\S]{0,400}body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'payment-profile PATCH must refuse currency when Multi-currency is off — stored profiles stay',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/[id]/route.ts'),
    /resource === 'profiles'[\s\S]{0,500}body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'payment-profile PATCH must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/[id]/route.ts'),
    /resource === 'profiles'[\s\S]{0,600}updatePaymentBankProfile/,
    'payment-profile PATCH must keep the stored currency when Multi-currency is off and the field is omitted',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/route.ts'),
    /resource === 'profiles'[\s\S]{0,400}body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'payment-profile create must refuse currency when Multi-currency is off — stored profiles stay',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/route.ts'),
    /resource === 'profiles'[\s\S]{0,500}body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'payment-profile create must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/admin/payment-operations/[resource]/route.ts'),
    /body\.currency === undefined[\s\S]{0,250}coalesce\(nullif\(f\.currency/,
    'payment-profile create must keep the format / subsidiary / org fallback when currency is omitted',
  )
  assert.match(
    read('app/(app)/admin/setup/payment-operations/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'payment operations must not load the profile currency control when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/admin/setup/payment-operations/PaymentOperationsSetup.tsx'),
    /paymentFormatId:[\s\S]{0,80}multiCurrency \? \{[\s\S]{0,80}currency/,
    'the payment-profile form must not send currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/admin/setup/payment-operations/PaymentOperationsSetup.tsx'),
    /\{multiCurrency \? <CurrencyField[\s\S]{0,120}format\?\.currency/,
    'the payment-profile form must hide the currency picker when Multi-currency is off',
  )
  assert.match(
    read('app/api/parties/[id]/bank-accounts/route.ts'),
    /body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'party bank-account create must refuse currency when Multi-currency is off — stored accounts stay',
  )
  assert.match(
    read('app/api/parties/[id]/bank-accounts/route.ts'),
    /body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'party bank-account create must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/parties/[id]/bank-accounts/route.ts'),
    /body\.currency !== undefined \? \(body\.currency\?\.trim\(\)\.toUpperCase\(\) \|\| null\) : null/,
    'party bank-account create must keep a null currency when the field is omitted',
  )
  assert.match(
    read('app/api/parties/[id]/bank-accounts/route.ts'),
    /export async function PATCH[\s\S]{0,1500}body\.currency !== undefined[\s\S]{0,80}multiCurrency/,
    'party bank-account PATCH must refuse currency when Multi-currency is off — stored accounts stay',
  )
  assert.match(
    read('app/api/parties/[id]/bank-accounts/route.ts'),
    /export async function PATCH[\s\S]{0,1500}body\.currency !== undefined[\s\S]{0,200}status: 404/,
    'party bank-account PATCH must 404 — not persist — currency when Multi-currency is off',
  )
  assert.match(
    read('app/api/parties/[id]/bank-accounts/route.ts'),
    /currency = \$\{body\.currency !== undefined \? body\.currency\?\.trim\(\)\.toUpperCase\(\) \|\| null : sql`currency`\}/,
    'party bank-account PATCH must keep the stored currency when Multi-currency is off and the field is omitted',
  )
  assert.match(
    read('app/(app)/parties/page.tsx'),
    /isFeatureEnabled\([^,]+, ['"]multiCurrency['"]\)/,
    'the parties page must not load the bank-account currency control when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/parties/PartyDrawer.tsx'),
    /bankName: draft\.bankName\.trim\(\)[\s\S]{0,120}multiCurrency \? \{[\s\S]{0,80}currency/,
    'the party bank-account create must not send currency when Multi-currency is off',
  )
  assert.match(
    read('app/(app)/parties/PartyDrawer.tsx'),
    /\{multiCurrency \? <div className=\{field\}><Label>\{tc\('labels\.currency'\)\}<\/Label><Select value=\{draft\.currency/,
    'the party bank-account create must hide the currency picker when Multi-currency is off',
  )
  assert.match(
    read('lib/customization/entity-list-query.ts'),
    /function customerBaseJoins[\s\S]{0,200}crm_account_profiles/,
    'customer list queries must name the CRM profile join the Features switch omits',
  )
  assert.match(
    read('lib/customization/entity-list-query.ts'),
    /function customerStatusExpr[\s\S]{0,120}crmOn \? sql`coalesce\(cap\.lifecycle_stage[\s\S]{0,80}'customer'/,
    'customer list queries must not read CRM lifecycle when CRM is off — stored profiles stay',
  )
  assert.match(
    read('lib/customization/entity-list-query.ts'),
    /!crmOn && adhoc\.filters\.status !== 'customer'[\s\S]{0,80}and false/,
    'customer list queries must not filter by prospect when CRM is off',
  )
  assert.match(
    read('components/entity-list-view.tsx'),
    /isFeatureEnabled\(orgId, 'crm'\)/,
    'the entity list must read the CRM switch before rendering customer lifecycle',
  )
  assert.match(
    read('components/entity-list-view.tsx'),
    /recordTypeForFeatureState\(catalog, \{ inventory: inventoryOn, crm: crmOn \}\)/,
    'the entity list must hide customer prospect filters when CRM is off',
  )
  assert.match(
    read('../packages/customization/src/registry.ts'),
    /features\.crm === false && out\.key === ['"]customer['"][\s\S]{0,400}option\.value === ['"]customer['"]/,
    'customer list customization must drop prospect when CRM is off',
  )
  assert.match(
    read('app/api/parties/[id]/activities/route.ts'),
    /guardFeaturePermission\('crm.activities.read', 'crm'\)/,
    'party activity sublist must 404 when CRM is off — stored activities stay',
  )
  assert.match(
    read('app/(app)/parties/page.tsx'),
    /crmEnabled && can\(authz, 'crm.activities.read'\)/,
    'the parties page must hide CRM activities when CRM is off — stored activities stay',
  )
  assert.match(
    read('app/(app)/entities/[role]/page.tsx'),
    /crmEnabled && can\(authz, 'crm.activities.read'\)/,
    'entities must hide CRM activities when CRM is off — stored activities stay',
  )
  assert.match(
    read('app/(app)/layout.tsx'),
    /crmEnabled && can\(authz, 'crm.activities.read'\)/,
    'the global party drawer must hide CRM activities when CRM is off — stored activities stay',
  )
  assert.match(
    read('app/(app)/layout.tsx'),
    /isFeatureEnabled\(authz\.user\.orgId, 'orders'\)[\s\S]{0,400}isFeatureEnabled\(authz\.user\.orgId, 'expenses'\)/,
    'the shell must resolve the Orders and Expenses switches for the create menu',
  )
  assert.match(
    read('app/(app)/layout.tsx'),
    /expenses: can\(authz, 'expenses\.create'\) && expensesEnabled/,
    'the global create menu must hide Expense when Expenses is off — the draft API 404s',
  )
  assert.match(
    read('app/(app)/dashboard/_quick-actions-shared.ts'),
    /id: 'd-expense'[\s\S]{0,280}requiredFeature: 'expenses'/,
    'the dashboard catalog must hide New expense when Expenses is off — the draft API 404s',
  )
  assert.match(
    read('app/(app)/dashboard/actions.ts'),
    /action\.requiredFeature && !featureEnabled\(featureState, action\.requiredFeature\)/,
    'the dashboard catalog must omit New expense when Expenses is off — stored layouts stay',
  )
  // The navigate picker must consume hiddenNavModules — the same mapping the
  // sidebar resolver applies — instead of hand-maintained per-key filters.
  // The hardcoded chain this replaces covered only a subset of FEATURES
  // navModules, so gated modules like CRM, Timesheets, Payroll, Subcontracts,
  // WIP billing, Property Management, Compliance, Inventory, Banking, Apps,
  // Scripts, API keys, and the query console stayed listed as dead Navigate
  // options pointing at routes that 404 with their feature off.
  assert.match(
    read('app/(app)/dashboard/actions.ts'),
    /const hiddenModules = hiddenNavModules\(featureState\)/,
    'the dashboard picker must derive hidden modules from the feature registry, not a hand-written list',
  )
  assert.match(
    read('app/(app)/dashboard/actions.ts'),
    /hiddenModules\.has\(mod\.key\)/,
    'the dashboard picker must drop every module a disabled feature hides — stored layouts stay',
  )
  assert.match(
    read('app/(app)/dashboard/actions.ts'),
    /resolvedFeatureState\(authz\.user\.orgId\)/,
    'the dashboard picker must resolve data-dependent feature defaults exactly like the sidebar resolver',
  )
  assert.doesNotMatch(
    read('app/(app)/dashboard/actions.ts'),
    /featureOn\.get\(/,
    'the dashboard picker must not fork per-key feature filters — hiddenNavModules is the single source of truth',
  )
  assert.match(
    read('lib/nav/resolve.ts'),
    /featureHiddenModules = hiddenNavModules\(featureState\)/,
    'the sidebar resolver and the dashboard picker must share one hidden-module mapping',
  )
  assert.match(
    read('app/(app)/layout.tsx'),
    /projects: can\(authz, 'projects\.manage'\) && projectsEnabled/,
    'the global create menu must hide Project when Projects is off — the draft API refuses',
  )
  assert.match(
    read('app/(app)/layout.tsx'),
    /assets: can\(authz, 'assets\.manage'\) && assetsEnabled/,
    'the global create menu must hide Asset when Fixed Assets is off — the draft API 404s',
  )
  assert.match(
    read('app/(app)/layout.tsx'),
    /orders: ordersEnabled/,
    'the global create menu must receive the Orders switch — quotes/SOs/POs must disappear when it is off',
  )
  assert.match(
    read('components/global-create-menu.tsx'),
    /p\.accountsReceivable && p\.orders/,
    'the create menu must hide estimate/sales-order when Orders is off',
  )
  assert.match(
    read('components/global-create-menu.tsx'),
    /p\.accountsPayable && p\.orders/,
    'the create menu must hide purchase-order when Orders is off',
  )
  assert.match(
    read('app/(app)/parties/PartyDrawer.tsx'),
    /initialTab === 'activities' && !canReadActivities/,
    'the party drawer must omit the activities tab when CRM is off — stored activities stay',
  )
  assert.match(
    read('app/api/pay/[token]/route.ts'),
    /isFeatureEnabled\([^,]+, ['"]onlinePayments['"]\)/,
    'hosted checkout must refuse when Online Payments is off — stored links stay',
  )
  assert.match(
    read('app/api/pay/[token]/route.ts'),
    /status: 404/,
    'hosted checkout must 404 — not create a payment attempt — when Online Payments is off',
  )
  assert.match(
    read('../engine/src/payment-acceptance.ts'),
    /export async function createCheckoutSession[\s\S]{0,400}onlinePaymentsFeatureEnabled/,
    'createCheckoutSession must not insert payment_attempts when Online Payments is off — stored links stay',
  )
  assert.match(
    read('../engine/src/payment-acceptance.ts'),
    /export async function publicPaymentPage[\s\S]{0,250}onlinePaymentsFeatureEnabled/,
    'the hosted pay page must hide when Online Payments is off — stored links stay',
  )
  assert.match(
    read('lib/pdf-templates/send.ts'),
    /isFeatureEnabled\([^,]+, ['"]onlinePayments['"]\)/,
    'invoice email must omit the pay-online link when Online Payments is off — stored links stay',
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
