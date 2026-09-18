import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// The guard lives behind server-only (like every route module); the shim
// stands in for the server boundary. All setup completes before the first
// test() registration below.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    return next(specifier, context)
  },
})
const { filingGuardKind, payrollRowScope } = await import('./subsidiary-scope')

// The subsidiary-scope guard routes by declaration, never by (country,
// filing) pairs: the filing's cadence decides which ownership proves its
// rows, and its parseRowId resolves every row id. DB-free: routing and
// parsing are pure — the SQL executors they choose are covered by the
// row-scope integration tests.

const EMP = '11111111-1111-1111-8111-111111111111'
const ACCT = '22222222-2222-2222-8222-222222222222'

test('guard routing follows the declared cadence', () => {
  assert.equal(filingGuardKind('CA', 't4'), 'annual')
  assert.equal(filingGuardKind('CA', 'rl1'), 'annual')
  assert.equal(filingGuardKind('US', 'w2'), 'annual')
  assert.equal(filingGuardKind('US', '941'), 'quarterly')
  assert.equal(filingGuardKind('CA', 'roe'), 'separation')
})

test('guard routing fails closed on anything undeclared', () => {
  assert.equal(filingGuardKind('CA', 'p60'), null)
  assert.equal(filingGuardKind('XX', 't4'), null)
  assert.equal(filingGuardKind('US', 't4'), null)
})

test('guard row parsing resolves through the filing declaration', () => {
  assert.deepEqual(payrollRowScope('CA', 't4', `${EMP}:ON:${ACCT}`), {
    employees: [EMP],
    accounts: [ACCT],
  })
  assert.deepEqual(payrollRowScope('CA', 'roe', EMP), { employees: [EMP], accounts: [] })
  assert.deepEqual(payrollRowScope('CA', 'rl1', EMP), { employees: [EMP], accounts: [] })
  assert.deepEqual(payrollRowScope('US', 'w2', `${EMP}:`), { employees: [EMP], accounts: [] })
  assert.deepEqual(payrollRowScope('US', '941', ':2'), { employees: [], accounts: [] })
  assert.equal(payrollRowScope('CA', 't4', 'not-a-row'), null)
  assert.equal(payrollRowScope('US', '941', `${ACCT}:9`), null)
  assert.equal(payrollRowScope('XX', 't4', EMP), null)
})
