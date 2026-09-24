import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { missingPayrollControlAccounts } from './payroll-setup-checklist.ts'

/**
 * Overview wiring for the setup checklist (F-t08-016): the payroll home
 * derives its banner from the packSlotState walk — every statutory slot of
 * every installed pack — plus the two country-free accounts. Legacy CA
 * keys in the settings blob must never drive the banner on their own.
 */
const checklistKey = Symbol.for('openbooks.payroll-checklist-wiring-test')
const checklistState: {
  slotInputs: unknown[]
  slots: Array<{ country: string; slots: Array<{ key: string; accountId: string | null }> }>
} = {
  slotInputs: [],
  slots: [{ country: 'US', slots: [{ key: 'federal-withholding', accountId: null }] }],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[checklistKey] = checklistState

const checklistHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@openbooks/engine/src/platform/business-date.ts') {
      return { shortCircuit: true, url: 'data:text/javascript,export async function businessToday() { return "2026-09-24" }' }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts') {
      return { shortCircuit: true, url: 'data:text/javascript,export const db = { async execute() { return { rows: [] } } }' }
    }
    if (specifier === '@openbooks/engine/src/payroll/readiness.ts') {
      return {
        shortCircuit: true,
        url: 'data:text/javascript,export async function installedPayrollCountries() { return ["US"] }'
          + '; export async function payrollPopulationRegions() { return [] }',
      }
    }
    if (specifier === '@openbooks/engine/src/payroll/packs.ts') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export async function packSlotState(orgId, installed, settings, regions) {
          globalThis[Symbol.for('openbooks.payroll-checklist-wiring-test')].slotInputs.push({ orgId, installed, settings, regions });
          return globalThis[Symbol.for('openbooks.payroll-checklist-wiring-test')].slots;
        }`,
      }
    }
    if (specifier === '@openbooks/engine/src/payroll/run-setup.ts') {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export async function payrollSettings() {
          return { wageExpenseAccountId: 'wage', netPayAccountId: 'net',
            cppPayableAccountId: null, eiPayableAccountId: null,
            taxPayableAccountId: null, vacationPayableAccountId: null };
        }`,
      }
    }
    if (specifier === '@openbooks/engine/src/payroll/run-calendar.ts') {
      return { shortCircuit: true, url: 'data:text/javascript,export function nextPeriodAfter() { return null }' }
    }
    return nextResolve(specifier, context)
  },
})

const { payrollHome } = await import('./module-home/payroll.ts')
checklistHooks.deregister()

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

test('the overview derives its checklist from pack slot states, not legacy keys', async () => {
  checklistState.slotInputs = []

  const home = await payrollHome('org-1')

  assert.deepEqual(home.missingSettings, [{ labelKey: 'packAccounts.US.slots.federal-withholding' }])
  assert.equal(checklistState.slotInputs.length, 1, 'the overview walks the installed packs once')
  const input = checklistState.slotInputs[0] as { orgId: string; installed: unknown; settings: unknown }
  assert.equal(input.orgId, 'org-1')
  assert.deepEqual(input.installed, ['US'])
  assert.ok(
    !home.missingSettings.some((slot) => slot.labelKey.includes('.CA.')),
    'legacy CA keys in the settings blob must not drive the banner on their own',
  )
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
