import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(join(import.meta.dirname, 'open-items.ts'), 'utf8')
const customerHome = readFileSync(join(import.meta.dirname, '..', 'module-home', 'customers.ts'), 'utf8')
const purchasingHome = readFileSync(join(import.meta.dirname, '..', 'module-home', 'purchasing.ts'), 'utf8')

test('cash open items use only the document current posted projection', () => {
  assert.match(source, /je\.org_id = \$\{orgId\} and je\.status = 'posted'/)
  assert.match(source, /d\.org_id = \$\{orgId\}/)
  // The query drives from documents (open_balance pre-filter) and joins the
  // posting entry through the document's own current-projection linkage.
  assert.match(source, /je\.id = d\.posted_entry_id/)
  assert.match(source, /d\.status = 'posted'/)
  assert.doesNotMatch(source, /je\.status in \('posted', 'reversed'\)/)
})

test('customer and purchasing home metrics reject superseded projections', () => {
  assert.match(customerHome, /je\.org_id = \$\{orgId\} and je\.status = 'posted'/)
  assert.match(customerHome, /d\.org_id = \$\{orgId\}/)
  assert.match(customerHome, /d\.posted_entry_id = je\.id/)
  assert.match(customerHome, /d\.status = 'posted'/)
  assert.doesNotMatch(customerHome, /je\.status in \('posted', 'reversed'\)/)

  // F-t03-009: purchasing groups the hero off the shared openItems reader
  // instead of a second journal aggregate that drifted from /ap.
  assert.match(purchasingHome, /openItems\(/)
  assert.match(purchasingHome, /from ['"].*cash\/core['"]/)
  assert.doesNotMatch(purchasingHome, /je\.status in \('posted', 'reversed'\)/)
  assert.doesNotMatch(purchasingHome, /from journal_lines jl/)
})
