import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const {
  PAYROLL_RESTRICTED_PARTY_LABEL,
  canSeePayrollDetail,
  collapseRestrictedPayrollLines,
} = await import('./payroll-confidentiality.ts')

type Line = {
  entryId: string
  accountId: string
  partyId: string | null
  payrollOrigin: boolean
  amount: string
  party: string | null
  memo: string | null
}

const line = (overrides: Partial<Line> & { entryId: string; accountId: string; amount: string }): Line => ({
  partyId: null,
  payrollOrigin: false,
  party: null,
  memo: null,
  ...overrides,
})

const build = (first: Line, total: string): Line => ({
  ...first,
  party: PAYROLL_RESTRICTED_PARTY_LABEL,
  memo: null,
  amount: total,
})

test('party-tagged payroll lines collapse into one line per entry per account with the summed amount', () => {
  const lines = [
    line({ entryId: 'e1', accountId: 'netpay', amount: '1500.0000', partyId: 'alice', payrollOrigin: true, party: 'Alice', memo: 'cheque 1' }),
    line({ entryId: 'e1', accountId: 'netpay', amount: '2500.0000', partyId: 'bob', payrollOrigin: true, party: 'Bob', memo: 'cheque 2' }),
    line({ entryId: 'e1', accountId: 'bank', amount: '-4000.0000' }),
  ]
  const out = collapseRestrictedPayrollLines(lines, build)
  assert.equal(out.length, 2)
  assert.equal(out[0]?.party, PAYROLL_RESTRICTED_PARTY_LABEL)
  assert.equal(out[0]?.memo, null)
  assert.equal(out[0]?.amount, '4000.0000')
  assert.equal(out[0]?.accountId, 'netpay')
  assert.equal(out[1]?.accountId, 'bank')
  assert.equal(out[1]?.amount, '-4000.0000')
})

test('totals are preserved by construction across mixed populations', () => {
  const lines = [
    line({ entryId: 'e1', accountId: 'wages', amount: '5000.0000' }),
    line({ entryId: 'e1', accountId: 'netpay', amount: '-1500.0000', partyId: 'alice', payrollOrigin: true, party: 'Alice' }),
    line({ entryId: 'e1', accountId: 'netpay', amount: '-2500.0000', partyId: 'bob', payrollOrigin: true, party: 'Bob' }),
    line({ entryId: 'e1', accountId: 'tax', amount: '-1000.0000' }),
  ]
  const out = collapseRestrictedPayrollLines(lines, build)
  const totalOf = (rows: Line[]): number => rows.reduce((n, row) => n + Number(row.amount), 0)
  assert.equal(totalOf(out), totalOf(lines))
  assert.equal(out.length, 3)
})

test('non-payroll party lines and party-less payroll lines pass through untouched', () => {
  const vendor = line({ entryId: 'e2', accountId: 'ap', amount: '-300.0000', partyId: 'vendor', payrollOrigin: false, party: 'Vendor Inc' })
  const bankLeg = line({ entryId: 'e1', accountId: 'bank', amount: '-4000.0000', payrollOrigin: true })
  const out = collapseRestrictedPayrollLines([vendor, bankLeg], build)
  assert.deepEqual(out, [vendor, bankLeg])
})

test('groups from different entries or accounts never merge', () => {
  const lines = [
    line({ entryId: 'e1', accountId: 'netpay', amount: '1500.0000', partyId: 'alice', payrollOrigin: true, party: 'Alice' }),
    line({ entryId: 'e2', accountId: 'netpay', amount: '1500.0000', partyId: 'alice', payrollOrigin: true, party: 'Alice' }),
    line({ entryId: 'e1', accountId: 'other', amount: '1500.0000', partyId: 'alice', payrollOrigin: true, party: 'Alice' }),
  ]
  const out = collapseRestrictedPayrollLines(lines, build)
  assert.equal(out.length, 3)
})

test('the collapsed line lands at its group first position', () => {
  const lines = [
    line({ entryId: 'e1', accountId: 'bank', amount: '-4000.0000' }),
    line({ entryId: 'e1', accountId: 'netpay', amount: '1500.0000', partyId: 'alice', payrollOrigin: true, party: 'Alice' }),
    line({ entryId: 'e1', accountId: 'netpay', amount: '2500.0000', partyId: 'bob', payrollOrigin: true, party: 'Bob' }),
  ]
  const out = collapseRestrictedPayrollLines(lines, build)
  assert.equal(out.length, 2)
  assert.equal(out[0]?.accountId, 'bank')
  assert.equal(out[1]?.party, PAYROLL_RESTRICTED_PARTY_LABEL)
})

test('empty input collapses to empty', () => {
  assert.deepEqual(collapseRestrictedPayrollLines([], build), [])
})

test('payroll detail visibility follows the payroll.read grant', () => {
  const reader = (permissions: string[]) =>
    ({ permissions: new Set(permissions) }) as unknown as Parameters<typeof canSeePayrollDetail>[0]
  assert.equal(canSeePayrollDetail(reader(['reports.read'])), false)
  assert.equal(canSeePayrollDetail(reader(['reports.read', 'payroll.read'])), true)
  assert.equal(canSeePayrollDetail(reader(['gl.read'])), false)
  assert.equal(canSeePayrollDetail(null), false)
  assert.equal(canSeePayrollDetail(undefined), false)
})
