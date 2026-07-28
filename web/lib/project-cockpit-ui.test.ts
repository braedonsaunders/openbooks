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
