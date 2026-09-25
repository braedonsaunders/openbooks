import assert from 'node:assert/strict'
import nodeTest from 'node:test'
import { allocationPortionFromInput } from './SplitLinesEditor.tsx'
import { canSaveBankRule, serializeLines } from '../../app/(app)/banking/rules/RuleDrawer'

// The repository's normal suite uses node:test, while the focused scheduler
// check invokes Vitest. Select the active runner without making Vitest a
// production dependency or changing the package manifest.
const runnerModule = 'vitest'
const runTest = process.env.VITEST ? (await import(runnerModule)).test : nodeTest

runTest('split inputs preserve exact decimal text end to end', () => {
  const precise = '9007199254740993.123456789'

  assert.deepEqual(
    allocationPortionFromInput({ kind: 'fixed', value: '0' }, precise),
    { kind: 'fixed', value: precise },
  )
  assert.deepEqual(
    allocationPortionFromInput({ kind: 'percent', value: 0 }, '12.123456789012345'),
    { kind: 'percent', value: '12.123456789012345' },
  )
})

runTest('bank-rule serialization preserves project coding and exact portion values', () => {
  const lines = serializeLines([
    { accountId: 'acct-1', projectId: 'project-9', portion: { kind: 'weight', value: '0.1250' } },
  ])

  assert.equal(lines.length, 1)
  assert.equal(lines[0]!.accountId, 'acct-1')
  assert.equal(lines[0]!.projectId, 'project-9')
  assert.deepEqual(lines[0]!.portion, { kind: 'weight', value: '0.1250' })
})

runTest('limited bank-rule scope needs an account before save', () => {
  const draft = {
    name: 'Card charges',
    conditionCount: 1,
    action: 'categorize' as const,
    lines: [{ accountId: 'revenue', portion: { kind: 'remainder' as const } }],
  }
  assert.equal(canSaveBankRule({ ...draft, scopeOpen: true, scope: [] }), false)
  assert.equal(canSaveBankRule({ ...draft, scopeOpen: true, scope: ['cash-1'] }), true)
})
