import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const source = readFileSync(join(import.meta.dirname, 'open-items.ts'), 'utf8')
const customerHome = readFileSync(join(import.meta.dirname, '..', 'module-home', 'customers.ts'), 'utf8')
const purchasingHome = readFileSync(join(import.meta.dirname, '..', 'module-home', 'purchasing.ts'), 'utf8')

test('cash open items read the posting through the shared as-of reconstruction', () => {
  // F-t03-010 pinned the live posted_entry_id join so a corrected bill could
  // not read twice. That join has been superseded: a live pointer lets a
  // later correction or void rewrite past forecasts, so the property pinned
  // here is the reconstruction — the document's posting as of the date from
  // journal history, never the live pointer or a live-status filter — which
  // keeps the F-t03-010 guarantee (reversed entries never become a second
  // item: only not-yet-reversed entries are effective as of the date).
  assert.match(source, /asOfPostedEntryLateral/)
  assert.match(source, /d\.org_id = \$\{orgId\}/)
  // Liveness is date-gated too: posted, or voided strictly after the date —
  // a later void hides the document forward, never backward.
  assert.match(source, /d\.voided_at/)
  assert.doesNotMatch(source, /je\.id = d\.posted_entry_id/)
  assert.doesNotMatch(source, /je\.status = 'posted'/)
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
