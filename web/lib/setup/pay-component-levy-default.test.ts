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

test('other entities and employer contributions pass through untouched', () => {
  const account = { kind: 'earning', taxable: false }
  assert.equal(foldPayComponentSetupCreate('payroll-filing-accounts', account), account)
  const contribution = { kind: 'employer_contribution', country: 'CA' }
  assert.equal(foldPayComponentSetupCreate('pay-components', contribution), contribution)
})

test('a new deduction starts outside the protected base unless it says otherwise', () => {
  // Disposable earnings are pay after deductions required by law: a 401(k)
  // deferral created with no stated membership must not shrink the base.
  assert.deepEqual(
    foldPayComponentSetupCreate('pay-components', { kind: 'deduction', country: 'US' }),
    { kind: 'deduction', country: 'US', includeInDisposableEarnings: false },
  )
  const required = { kind: 'deduction', country: 'US', includeInDisposableEarnings: true }
  assert.equal(foldPayComponentSetupCreate('pay-components', required), required)
})
