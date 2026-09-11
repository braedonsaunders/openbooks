import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readingPagePairs } from './page-source'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readingPagePairs((path: string) => readFileSync(join(webRoot, path), 'utf8'))

const entityLists = [
  'app/(app)/accounts/page.tsx',
  'app/(app)/assets/equipment/page.tsx',
  'app/(app)/assets/page.tsx',
  'app/(app)/banking/imports/page.tsx',
  'app/(app)/banking/reconciliations/page.tsx',
  'app/(app)/banking/rules/page.tsx',
  'app/(app)/budgets/page.tsx',
  'app/(app)/crm/AccountList.tsx',
  'app/(app)/crm/activities/page.tsx',
  'app/(app)/crm/opportunities/page.tsx',
  'app/(app)/entities/[role]/page.tsx',
  'app/(app)/inventory/page.tsx',
  'app/(app)/items/page.tsx',
  'app/(app)/journal/page.tsx',
  'app/(app)/projects/page.tsx',
  'app/(app)/revenue/page.tsx',
  'app/(app)/timesheets/page.tsx',
]

const transactionLists = [
  'app/(app)/ap/bills/page.tsx',
  'app/(app)/ar/invoices/page.tsx',
  'app/(app)/banking/transactions/page.tsx',
  'app/(app)/estimates/page.tsx',
  'app/(app)/expenses/reports/page.tsx',
  'app/(app)/field-tickets/page.tsx',
  'app/(app)/payments/PaymentsSection.tsx',
  'app/(app)/purchase-orders/page.tsx',
  'app/(app)/sales-orders/page.tsx',
]

/**
 * A page reaches a shared list either by rendering the component or by placing
 * it as a widget block — `widgetBlock('entity-list-view')` mounts the very
 * same EntityListView. The invariant is that these lists are not hand-rolled;
 * which of the two spellings a page uses is not part of it.
 */
const ENTITY_LIST = /EntityListView|widgetBlock\('entity-list-view'/
const RECORD_LIST = /RecordListView|widgetBlock\('record-list-view'/

test('primary business record lists use the shared list implementations', () => {
  for (const path of entityLists) assert.match(source(path), ENTITY_LIST, path)
  for (const path of transactionLists) assert.match(source(path), RECORD_LIST, path)
})

test('both shared list implementations mount the saved-view menu', () => {
  assert.match(source('components/entity-list-view.tsx'), /<ViewsMenu/)
  assert.match(source('components/record-list-view.tsx'), /<ViewsMenu/)
})

test('personal saved-view actions are available without org customization permission', () => {
  const menu = source('components/views-menu.tsx')
  assert.match(menu, /scope=\$\{manageScope\}/)
  assert.doesNotMatch(menu, /\{canManage \? \(\s*<>\s*<Link/)
  // Passed as a JSX attribute or bound as a spec prop — `canManageOrg:
  // data.viewDrawerCanManage` is the same forwarding, one indirection away.
  assert.match(source('app/(app)/admin/customization/page.tsx'), /canManageOrg[=:]/)
})
