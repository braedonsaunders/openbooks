import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { INDUSTRY_BY_KEY } = await import('./industries.ts')
hooks.deregister()

test('nonprofit preset has unique net-asset account numbers', () => {
  const nonprofit = INDUSTRY_BY_KEY.get('nonprofit')
  assert.ok(nonprofit)

  const numbers = nonprofit.coa.map((account) => account.number)
  assert.equal(new Set(numbers).size, numbers.length)
  assert.deepEqual(
    nonprofit.coa.filter((account) => account.type === 'equity').map(({ number, name }) => ({ number, name })),
    [
      { number: '3000', name: 'Unrestricted Net Assets' },
      { number: '3100', name: 'Temporarily Restricted Net Assets' },
      { number: '3200', name: 'Permanently Restricted Net Assets' },
    ],
  )
})

test('nonprofit preset keeps its project revenue control account valid', () => {
  const nonprofit = INDUSTRY_BY_KEY.get('nonprofit')
  assert.ok(nonprofit)

  assert.equal(nonprofit.controlAccounts.projectRevenue, '4100')
  assert.equal(nonprofit.coa.find((account) => account.number === '4100')?.name, 'Grant Revenue')
})

test('the withheld-payroll-tax role maps to a deductions account, never a payable', () => {
  // Withheld PAYE/NIC/PRSI/USC must sit in the chart's payroll-deductions
  // account (2110/2300 family, liability_current_other) — never in a vendor
  // or subcontractor payable (2130 family, liability_payable), where employee
  // tax would mingle with accounts payable.
  for (const industry of INDUSTRY_BY_KEY.values()) {
    const mapped = industry.controlAccounts.payrollDeductions
    const deductions = industry.coa.find(
      (account) => /payroll deductions/i.test(account.name) && account.type === 'liability_current_other',
    )
    if (!deductions) {
      assert.equal(mapped, undefined, `${industry.key} has no deductions account so maps no role`)
      continue
    }
    assert.equal(mapped, deductions.number, `${industry.key} resolves withheld payroll tax to its deductions account`)
  }
})
