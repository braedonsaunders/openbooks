import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// The loader resolves the Flows approval state server-side through the
// native engine and hands it to the wizard as plain data (the expenses
// precedent: canSubmit resolved on the server, composed with status on the
// client). These tests pin that the loader — not the client — answers "is a
// flow configured", and that the state reaches the widget the wizard renders.
const source = readFileSync(new URL('./view.ts', import.meta.url), 'utf8')

test('the loader resolves approval through the native engine', () => {
  assert.match(source, /payRunApprovalState/)
  assert.match(source, /from '@openbooks\/engine\/src\/payroll\/approval\.ts'/)
})

test('approval resolves alongside the other engine reads', () => {
  const block = source.slice(source.indexOf('payRunReadiness(orgId, id'))
  assert.match(block.slice(0, 600), /payRunApprovalState\(orgId, id\)/)
})

test('the approval state reaches the wizard widget as data', () => {
  assert.match(source, /approval: PayRunApprovalState/)
  assert.match(source, /approval: data\.approval/)
  // approval is IN the object the loader returns, not necessarily its last
  // key -- pinning it last means the next property added after it breaks a
  // test about approval, naming the wrong culprit.
  assert.match(source, /approval,\n(?:\s+[\w.]+,\n)*    \}\n  \}\)/)
})
