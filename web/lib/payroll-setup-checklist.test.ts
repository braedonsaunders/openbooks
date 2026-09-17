import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { missingPayrollControlAccounts } from './payroll-setup-checklist.ts'

// F-t08-016: the /payroll overview demanded hardcoded legacy CA control
// accounts (CPP/EI payable) on a US-only tenant — accounts with no slot
// anywhere in US-pack setup, unresolvable by definition. The checklist must
// derive from the installed packs' declared liability slots (plus the two
// country-free accounts), with labels that resolve on the linked setup page.
function slot(country: string, key: string, accountId: string | null) {
  return { country, key, accountId }
}

test('a US-only tenant is asked only for US slots', () => {
  const missing = missingPayrollControlAccounts({
    wageExpenseAccountId: 'a1',
    netPayAccountId: 'a2',
    slots: [
      slot('US', 'fit', 'a3'),
      slot('US', 'fica', 'a4'),
      slot('US', 'futa', null),
      slot('US', 'suta', null),
      slot('US', 'state_income_tax', null),
      slot('US', 'local_income_tax', null),
    ],
  })
  assert.deepEqual(missing, [
    { labelKey: 'packAccounts.US.slots.futa' },
    { labelKey: 'packAccounts.US.slots.suta' },
    { labelKey: 'packAccounts.US.slots.state_income_tax' },
    { labelKey: 'packAccounts.US.slots.local_income_tax' },
  ])
  assert.ok(
    missing.every((item) => !item.labelKey.includes('CPP') && !/\.ei\b/i.test(item.labelKey)),
    'no Canadian program may be demanded of a US-only tenant',
  )
})

test('mapped slots and configured generic accounts leave nothing missing', () => {
  assert.deepEqual(
    missingPayrollControlAccounts({
      wageExpenseAccountId: 'a1',
      netPayAccountId: 'a2',
      slots: [slot('CA', 'cpp', 'a3'), slot('CA', 'ei', 'a4')],
    }),
    [],
  )
})

test('unconfigured wage and net-pay accounts are still demanded', () => {
  assert.deepEqual(
    missingPayrollControlAccounts({
      wageExpenseAccountId: null,
      netPayAccountId: '',
      slots: [],
    }),
    [
      { labelKey: 'fields.wageExpenseAccountId' },
      { labelKey: 'fields.netPayAccountId' },
    ],
  )
})

test('the overview derives its checklist from pack slot states, not legacy keys', () => {
  const source = readFileSync(new URL('./module-home/payroll.ts', import.meta.url), 'utf8')
  assert.match(source, /missingPayrollControlAccounts\(/)
  assert.match(source, /packSlotState\(/)
  assert.match(source, /installedPayrollCountries\(/)
  // The legacy CA keys must not drive the banner anymore.
  assert.doesNotMatch(source, /cppPayableAccountId/)
  assert.doesNotMatch(source, /eiPayableAccountId/)
  assert.doesNotMatch(source, /taxPayableAccountId/)
  assert.doesNotMatch(source, /vacationPayableAccountId/)
})

test('a CA tenant is asked for its own unmapped slots', () => {
  assert.deepEqual(
    missingPayrollControlAccounts({
      wageExpenseAccountId: 'a1',
      netPayAccountId: 'a2',
      slots: [slot('CA', 'cpp', null), slot('CA', 'income_tax', 'a3')],
    }),
    [{ labelKey: 'packAccounts.CA.slots.cpp' }],
  )
})
