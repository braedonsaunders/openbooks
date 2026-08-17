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
  for (const moduleSource of [customerHome, purchasingHome]) {
    assert.match(moduleSource, /je\.org_id = \$\{orgId\} and je\.status = 'posted'/)
    assert.match(moduleSource, /d\.org_id = \$\{orgId\}/)
    assert.match(moduleSource, /d\.posted_entry_id = je\.id/)
    assert.match(moduleSource, /d\.status = 'posted'/)
    assert.doesNotMatch(moduleSource, /je\.status in \('posted', 'reversed'\)/)
  }
})
