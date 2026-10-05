import assert from 'node:assert/strict'
import test from 'node:test'

// The fold is pure over the request body (no storage); only the module
// import is stubbed by server-only, exactly like the treatment-refusal test.
const { foldPayComponentSetupCreate } = await import('./write.ts')

test('a non-taxable earning without exclusions defaults to the CA levy keys', () => {
  assert.deepEqual(
    foldPayComponentSetupCreate('pay-components', { kind: 'earning', taxable: false, country: 'CA' }),
    { kind: 'earning', taxable: false, country: 'CA', programExclusions: ['cnt', 'eht', 'hsf', 'wcb'] },
  )
})

test('a taxable earning is left alone', () => {
  const body = { kind: 'earning', taxable: true, country: 'CA' }
  assert.equal(foldPayComponentSetupCreate('pay-components', body), body)
})

test('an earning with no stated taxability is left alone', () => {
  const body = { kind: 'earning', country: 'CA' }
  assert.equal(foldPayComponentSetupCreate('pay-components', body), body)
})

test('an explicit exclusion list is never rewritten', () => {
  const body = { kind: 'earning', taxable: false, country: 'CA', programExclusions: ['qpip'] }
  assert.equal(foldPayComponentSetupCreate('pay-components', body), body)
  const empty = { kind: 'earning', taxable: false, country: 'CA', programExclusions: [] as string[] }
  assert.equal(foldPayComponentSetupCreate('pay-components', empty), empty)
})

test('other entities and non-earnings pass through untouched', () => {
  const account = { kind: 'earning', taxable: false }
  assert.equal(foldPayComponentSetupCreate('payroll-filing-accounts', account), account)
  const deduction = { kind: 'deduction', taxable: false, country: 'CA' }
  assert.equal(foldPayComponentSetupCreate('pay-components', deduction), deduction)
})
