import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canReopenWeek,
  isReopenableStatus,
  lockReasonsFor,
  weekLockReasons,
  type EntryProvenance,
} from './time-lifecycle'

const free: EntryProvenance = {
  invoicedByLineId: null,
  payrollBatchRef: null,
  costJournalEntryId: null,
  fieldTicketId: null,
}

test('an untouched entry has no locks and its week reopens', () => {
  assert.deepEqual(lockReasonsFor(free), [])
  const decision = canReopenWeek([free, free])
  assert.equal(decision.allowed, true)
  assert.deepEqual(decision.reasons, [])
  assert.equal(decision.lockedCount, 0)
})

test('each downstream consumer pins the entry', () => {
  assert.deepEqual(lockReasonsFor({ ...free, invoicedByLineId: 'l1' }), ['invoiced'])
  assert.deepEqual(lockReasonsFor({ ...free, billingStatus: 'billed' }), ['invoiced'])
  assert.deepEqual(lockReasonsFor({ ...free, payrollBatchRef: 'run-1' }), ['paid'])
  assert.deepEqual(lockReasonsFor({ ...free, costJournalEntryId: 'je1' }), ['costed'])
  assert.deepEqual(lockReasonsFor({ ...free, overheadJournalEntryId: 'oh1' }), ['costed'])
  assert.deepEqual(lockReasonsFor({ ...free, fieldTicketId: 'ft1' }), ['ticketed'])
})

test('one consumed entry locks the whole week', () => {
  // All-or-nothing: reopening the rest would leave the week reading "draft"
  // while some of its hours are already invoiced.
  const decision = canReopenWeek([free, { ...free, invoicedByLineId: 'l1' }, free])
  assert.equal(decision.allowed, false)
  assert.equal(decision.lockedCount, 1)
  assert.deepEqual(decision.reasons, ['invoiced'])
})

test('reasons are deduped and reported in a stable order', () => {
  const reasons = weekLockReasons([
    { ...free, fieldTicketId: 'ft1' },
    { ...free, payrollBatchRef: 'run-1' },
    { ...free, payrollBatchRef: 'run-2' },
    { ...free, invoicedByLineId: 'l1' },
  ])
  assert.deepEqual(reasons, ['invoiced', 'paid', 'ticketed'])
})

test('an entry may be held by several consumers at once', () => {
  assert.deepEqual(
    lockReasonsFor({ invoicedByLineId: 'l1', payrollBatchRef: 'r', costJournalEntryId: 'j', fieldTicketId: 'f' }),
    ['invoiced', 'paid', 'costed', 'ticketed'],
  )
})

test('an empty week is not reopenable in practice but reports cleanly', () => {
  assert.deepEqual(canReopenWeek([]), { allowed: true, reasons: [], lockedCount: 0 })
})

test('only an approved week is reopenable', () => {
  assert.equal(isReopenableStatus('approved'), true)
  for (const status of ['draft', 'submitted', 'rejected', 'empty']) {
    assert.equal(isReopenableStatus(status), false, status)
  }
})
