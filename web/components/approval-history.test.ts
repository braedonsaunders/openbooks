import assert from 'node:assert/strict'
import test from 'node:test'
import { approvalTabBody } from './approval-history'

// F-t02-003: the receipt Approvals tab rendered a completely blank panel —
// no spinner, no content, no empty state. The tab body is a four-state
// machine; the component must render something visible for every state.
test('approval tab body states: loading, history, pending, empty', () => {
  assert.equal(approvalTabBody(null), 'loading')
  assert.equal(
    approvalTabBody({ history: [{ id: 'run:1' }], approvalState: { pendingWith: [] } }),
    'history',
  )
  assert.equal(
    approvalTabBody({
      history: [],
      approvalState: { pendingWith: [{ name: 'Controller', gateId: 'g1', since: '2026-09-01' }] },
    }),
    'pending',
  )
  assert.equal(approvalTabBody({ history: [], approvalState: { pendingWith: [] } }), 'empty')
})

test('history wins over a concurrent pending gate', () => {
  assert.equal(
    approvalTabBody({
      history: [{ id: 'run:1' }],
      approvalState: { pendingWith: [{ name: 'Controller', gateId: 'g1', since: '2026-09-01' }] },
    }),
    'history',
  )
})
