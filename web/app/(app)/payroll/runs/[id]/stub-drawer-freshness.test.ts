import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// F-t08-013: recalculation deletes every pay_stubs row and inserts fresh ones
// with new ids, so the open stub drawer kept rendering its opening snapshot
// (stale amounts) and its PDF link pointed at a deleted row (404) until
// reopen. The open stub must re-resolve against the live stubs on every
// render — by employee, since row ids churn on recalculate.
const source = readFileSync(new URL('./RunWizard.tsx', import.meta.url), 'utf8')
const review = source.slice(source.indexOf('function ReviewStep('))

test('the open stub drawer re-resolves against live stubs', () => {
  assert.match(review, /stubs\.find\([\s\S]{0,120}?employee_party_id/)
})

test('the stub drawer renders the re-resolved stub, not the snapshot', () => {
  const drawerBlock = review.slice(review.indexOf('<StubDrawer'))
  assert.doesNotMatch(drawerBlock.slice(0, 400), /stub=\{openStub\}/)
})
