import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({ resolve(specifier, _context, nextResolve) {
  if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
  return nextResolve(specifier)
} })

const { EXPENSE_TOOLS } = await import('./tools-expenses')

test('expense assistant tools expose read-only expense access with the expenses feature gate', () => {
  assert.deepEqual(EXPENSE_TOOLS.map((tool) => tool.name).sort(), [
    'expense_approvals',
    'expense_overview',
    'get_expense_report',
    'list_expense_reports',
  ])
  for (const tool of EXPENSE_TOOLS) {
    assert.deepEqual(tool.gate, { mode: 'anyOf', perms: ['expenses.read'] })
    assert.equal(tool.feature, 'expenses')
    assert.notEqual(tool.category, 'write')
  }
})
