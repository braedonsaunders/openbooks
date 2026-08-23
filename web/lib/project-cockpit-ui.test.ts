import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { getRecordType } from '@openbooks/customization'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

test('project charges are first-class customizable transactions, not a parallel project tab', () => {
  const project = getRecordType('project')
  const charge = getRecordType('project_charge')

  assert.ok(project)
  assert.equal(project.tabs?.some((tab) => tab.key === 'charges'), false)
  assert.ok(charge)
  assert.equal(charge.category, 'transaction')
  assert.deepEqual(
    charge.lineFields.map((field) => field.key),
    ['item_id', 'description', 'quantity', 'unit', 'cost_rate', 'amount', 'bill_rate', 'bill_amount', 'is_billable', 'project_id'],
  )
})

test('project planning is grouped under a customizable project-management tab', () => {
  const project = getRecordType('project')
  const drawer = source('app/(app)/projects/ProjectDrawer.tsx')

  assert.deepEqual(
    project?.tabs?.map((tab) => tab.key),
    ['overview', 'financials', 'project_management', 'cost_time', 'billing', 'transactions'],
  )
  assert.deepEqual(
    project?.tabs?.find((tab) => tab.key === 'project_management')?.subtabs?.map((tab) => tab.key),
    ['work_breakdown', 'schedule'],
  )
  assert.match(drawer, /tab === 'project_management'/)
  assert.match(drawer, /managementTab === 'work_breakdown'/)
  assert.match(drawer, /managementTab === 'schedule' && schedulingEnabled/)
  assert.doesNotMatch(drawer, /tab === 'work_breakdown'/)
  assert.doesNotMatch(drawer, /tab === 'schedule'/)
})

test('applications for payment stay inside project billing and use subtabs plus stacked flyouts', () => {
  const billing = source('app/(app)/projects/tabs/BillingSection.tsx')
  const workspace = source('app/(app)/construction/ConstructionClient.tsx')
  const projectsPage = source('app/(app)/projects/page.tsx')

  assert.match(billing, /<ApplicationsBillingWorkspace\b/)
  assert.match(workspace, /type BillingTab = "applications" \| "schedule" \| "changes" \| "retainage"/)
  assert.match(workspace, /role="tablist"/)
  assert.match(workspace, /<DrawEntryDrawer\b/)
  assert.match(workspace, /stacked/)
  assert.match(workspace, /\/ar\/invoices\?doc=/)
  assert.equal(existsSync(join(webRoot, 'app/(app)/construction/page.tsx')), false)
  assert.doesNotMatch(projectsPage, /href=.*\/construction/)
})

test('project transactions filter by native type and stack the transaction drawer', () => {
  const tab = source('app/(app)/projects/tabs/TransactionsTab.tsx')
  const page = source('app/(app)/projects/page.tsx')
  const drawer = source('app/(app)/projects/ProjectDrawer.tsx')
  const related = source('components/related-transaction-drawer.tsx')
  const relatedClient = source('components/related-transaction-drawer-client.tsx')

  assert.match(tab, /allTransactionTypes/)
  assert.match(tab, /transactions\.filter\(\(row\) => row\.kind === kind\)/)
  assert.match(tab, /toolbarAfter=/)
  assert.match(tab, /projectTxnKind/)
  assert.doesNotMatch(tab, /\/field-tickets\?ticket=/)
  assert.match(tab, /showKpis=\{false\}/)
  assert.match(tab, /<DocTypeBadge\b/)
  assert.match(page, /<RelatedTransactionDrawer\b/)
  assert.match(page, /projectId=\{String\(openProject\.project\.id\)\}/)
  assert.match(related, /kind === 'field_ticket'/)
  assert.match(related, /loadFieldTicketDrawerData/)
  assert.match(relatedClient, /type: 'fieldTicket'/)
  assert.match(relatedClient, /<FieldTicketDrawer\b/)
  assert.doesNotMatch(drawer, /tab === 'charges'/)
  assert.match(drawer, /setTab\('transactions'\); setChargeFormOpen\(true\)/)
})

test('field-ticket work tabs share the transaction drawer tab state', () => {
  const fieldTicket = source('app/(app)/field-tickets/FieldTicketDrawer.tsx')
  const transactionDrawer = source('components/transaction-drawer.tsx')

  assert.match(fieldTicket, /activeTab=\{activeSection\}/)
  assert.match(fieldTicket, /onActiveTabChange=\{setActiveSection\}/)
  assert.match(transactionDrawer, /controlledActiveTab \?\? localActiveTab/)
  assert.match(transactionDrawer, /onActiveTabChange\?\.\(tab\.key\)/)
})

test('cost-budget presentation follows capped project-type semantics', () => {
  const financials = source('app/(app)/projects/tabs/FinancialsTab.tsx')
  const loader = source('app/(app)/projects/_cockpit-data.ts')

  assert.match(loader, /totalPrice\.method === 'not_to_exceed'/)
  assert.match(financials, /line\.measure !== 'cost_budget'/)
  assert.match(financials, /line\.measure !== 'remaining_budget'/)
  assert.match(financials, /data\.costBudgetApplies \? \(/)
})

test('project financials clarify included overhead and keep revenue recognition in a flyout', () => {
  const financials = source('app/(app)/projects/tabs/FinancialsTab.tsx')
  const drawer = source('app/(app)/projects/ProjectDrawer.tsx')

  assert.match(financials, /overheadIncludedInTotalCost/)
  assert.match(financials, /line\.measure === 'total_cost'/)
  assert.match(financials, /overhead_informational/)
  assert.doesNotMatch(financials, /RecognitionCard/)
  assert.match(drawer, /setRecognitionOpen\(true\)/)
  assert.match(drawer, /<RecognitionCard\b/)
})

test('project transaction amounts use project-charge bill value and expose governed editing', () => {
  const financials = source('lib/project-financials.ts')
  const related = source('components/related-transaction-drawer.tsx')
  const document = source('components/document-drawer.tsx')

  assert.match(financials, /d\.kind = 'project_charge'[\s\S]*dl\.bill_amount/)
  assert.match(financials, /when dl\.bill_amount is not null/)
  assert.match(financials, /profile\.committedCost\.statuses \?\? \['approved'\]/)
  assert.match(related, /kind === 'project_charge' \? can\(authz, 'projects\.manage'\)/)
  assert.match(document, /config\.kind === 'project_charge'[\s\S]*\\? \{\}/)
  assert.match(document, /readOnly=\{!editable \|\| config\.kind === 'project_charge'\}/)
})

test('project actions link the existing General Ledger to the complete project posting range', () => {
  const drawer = source('app/(app)/projects/ProjectDrawer.tsx')
  const loader = source('app/(app)/projects/_cockpit-data.ts')
  const report = source('app/(app)/reports/general-ledger/page.tsx')
  const reports = source('lib/reports/filters.ts')

  assert.match(drawer, /reports\/general-ledger/)
  assert.match(drawer, /project: String\(pr\.id\)/)
  assert.match(loader, /min\(e\.posting_date\)/)
  assert.match(loader, /l\.project_id = \$\{projectId\}/)
  assert.match(report, /dimensionOptions\(undefined, dims\.projectId\)/)
  assert.match(reports, /p\.id = \$\{selectedProjectId \?\? null\}::uuid/)
})

test('project hours default to employee, roll up by service item, and drill to canonical approved time', () => {
  const tab = source('app/(app)/projects/tabs/CostTimeTab.tsx')
  const summary = source('lib/project-costing.ts')
  const detail = source('lib/project-time-detail.ts')
  const route = source('app/api/projects/[id]/time-entries/route.ts')

  assert.match(tab, /useState<TimeDimension>\('employee'\)/)
  assert.match(tab, /key: 'item' as const/)
  assert.match(tab, /data\.byItem/)
  assert.match(tab, /className="pt-2"/)
  assert.match(tab, /<TimeEntriesDrawer/)
  assert.match(tab, /stacked/)

  assert.match(summary, /te\.item_id as key/)
  assert.match(summary, /left join items i/)
  assert.match(summary, /te\.status = 'approved'/)
  assert.match(detail, /te\.project_id = \$\{args\.projectId\}/)
  assert.match(detail, /te\.org_id = \$\{args\.orgId\}/)
  assert.match(detail, /te\.status = 'approved'/)
  assert.match(detail, /case when te\.memo_is_private then null/)
  assert.match(detail, /limit \$\{pageSize\} offset \$\{offset\}/)
  assert.match(route, /guardPermission\('projects\.read'\)/)
  assert.match(route, /guardProjectsFeature/)
  assert.match(route, /rawKey !== 'unassigned' && !isUuid\(rawKey\)/)
})
