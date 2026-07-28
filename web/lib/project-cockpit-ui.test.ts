import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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

test('project transactions filter by native type and stack the transaction drawer', () => {
  const tab = source('app/(app)/projects/tabs/TransactionsTab.tsx')
  const page = source('app/(app)/projects/page.tsx')
  const drawer = source('app/(app)/projects/ProjectDrawer.tsx')

  assert.match(tab, /allTransactionTypes/)
  assert.match(tab, /transactions\.filter\(\(row\) => row\.kind === kind\)/)
  assert.match(tab, /toolbarAfter=/)
  assert.match(tab, /projectTxnKind/)
  assert.match(tab, /<DocTypeBadge\b/)
  assert.match(page, /<RelatedTransactionDrawer\b/)
  assert.match(page, /projectId=\{String\(openProject\.project\.id\)\}/)
  assert.doesNotMatch(drawer, /tab === 'charges'/)
  assert.match(drawer, /setTab\('transactions'\); setChargeFormOpen\(true\)/)
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
  assert.doesNotMatch(financials, /RecognitionCard/)
  assert.match(drawer, /setRecognitionOpen\(true\)/)
  assert.match(drawer, /<RecognitionCard\b/)
})

test('project transaction amounts use project-charge bill value and expose governed editing', () => {
  const financials = source('lib/project-financials.ts')
  const related = source('components/related-transaction-drawer.tsx')
  const document = source('components/document-drawer.tsx')

  assert.match(financials, /d\.kind = 'project_charge'[\s\S]*dl\.bill_amount/)
  assert.match(related, /kind === 'project_charge' \? can\(authz, 'projects\.manage'\)/)
  assert.match(document, /config\.kind === 'project_charge'[\s\S]*\\? \{\}/)
  assert.match(document, /readOnly=\{!editable \|\| config\.kind === 'project_charge'\}/)
})

test('project actions link the existing General Ledger to the complete project posting range', () => {
  const drawer = source('app/(app)/projects/ProjectDrawer.tsx')
  const loader = source('app/(app)/projects/_cockpit-data.ts')

  assert.match(drawer, /reports\/general-ledger/)
  assert.match(drawer, /project: String\(pr\.id\)/)
  assert.match(loader, /min\(e\.posting_date\)/)
  assert.match(loader, /l\.project_id = \$\{projectId\}/)
})
