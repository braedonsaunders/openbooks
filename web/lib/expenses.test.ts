import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// expenses.ts is a server-only module. The marker only gates RSC bundling,
// so replace it with an empty module for this pure eligibility test.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { canRecallExpenseReport } = await import('./expenses.ts')

const viewer = (id: string, roles: { key: string }[] = [{ key: 'accountant' }]) => ({ id, roles })
const submitted = (submitted_by: string | null | undefined, created_by: string) => ({
  status: 'pending_approval',
  submitted_by,
  created_by,
  void_requested_at: null,
})

test('the submitter may recall', () => {
  assert.equal(canRecallExpenseReport(submitted('sam', 'sam'), viewer('sam')), true)
})

test('the creator may NOT recall a report submitted by someone else', () => {
  assert.equal(
    canRecallExpenseReport(submitted('sam', 'assistant'), viewer('assistant')),
    false,
    'drafting for someone else must not grant recall over their submission',
  )
})

test('the creator may recall a legacy row with no recorded submitter', () => {
  assert.equal(
    canRecallExpenseReport(submitted(null, 'assistant'), viewer('assistant')),
    true,
  )
  assert.equal(
    canRecallExpenseReport(submitted(undefined, 'assistant'), viewer('assistant')),
    true,
  )
})

test('an admin may recall either way', () => {
  const admin = viewer('ada', [{ key: 'admin' }])
  assert.equal(canRecallExpenseReport(submitted('sam', 'assistant'), admin), true)
  assert.equal(canRecallExpenseReport(submitted(null, 'assistant'), admin), true)
})

test('a stranger may not recall', () => {
  assert.equal(canRecallExpenseReport(submitted('sam', 'sam'), viewer('outsider')), false)
})
