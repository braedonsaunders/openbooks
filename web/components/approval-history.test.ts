import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
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

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = (path: string) => readFileSync(join(webRoot, path), 'utf8')

// F-t04-001 (vendor bank-account Approvals dialog) + F-t04-002 (expense
// report Approvals tab): both bodies are <ApprovalHistory> without
// showEmptyState, which returned null whenever the record had no flow
// history — a completely blank dialog / tab. SIM tenants run no approval
// flows, so both surfaces were blank there. Both opt into the
// loading/pending/empty bodies; inline embeddings keep the compact default.
test('bank-account dialog and expense approvals tab opt into empty bodies', () => {
  const history = source('components/approval-history.tsx')
  assert.match(history, /if \(!showEmptyState\) return null/)
  const partyDrawer = source('app/(app)/parties/PartyDrawer.tsx')
  assert.match(
    partyDrawer,
    /<ApprovalHistory\s+subjectKind="party_bank_account"\s+subjectId=\{String\(historyAccount\.id\)\}\s+showEmptyState\s*\/>/,
    'vendor bank-account Approvals dialog must render loading/pending/empty, never a blank panel',
  )
  const expenseDrawer = source('app/(app)/expenses/ExpenseDrawer.tsx')
  assert.match(
    expenseDrawer,
    /<ApprovalHistory subjectKind="expense_report" subjectId=\{String\(doc\.id\)\} showEmptyState \/>/,
    'expense report Approvals tab must render loading/pending/empty, never a blank panel',
  )
})

// F-t04-004 residual: a record whose status claims it awaits approval, but
// which no flow run ever fired for, is neither history nor genuinely empty —
// the tab must name the stale state instead of "No approvals required".
test('a pending record never sent to any flow resolves its own tab body', () => {
  assert.equal(
    approvalTabBody({
      history: [],
      approvalState: { pendingWith: [], status: 'pending' },
      neverSubmitted: true,
    }),
    'unsubmitted',
  )
  assert.equal(
    approvalTabBody({ history: [], approvalState: { pendingWith: [], status: 'pending' } }),
    'empty',
  )
})
