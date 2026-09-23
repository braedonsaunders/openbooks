import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  accrualEarned,
  carryoverApplied,
} from '@openbooks/engine/src/hrm/leave-math.ts'
import {
  leavePolicyRuleProblem,
  normalizeHrmLeavePolicyInput,
} from './hrm-leave-policy'

const SUBSIDIARY = '00000000-0000-4000-8000-000000000001'
const DEPARTMENT = '00000000-0000-4000-8000-000000000002'

/** The engine's live refusal for a rule shape — the drawer must repeat these
 *  words, never its own paraphrase. */
function engineAccrualRefusal(rule: Record<string, unknown>): string {
  try {
    accrualEarned(rule as never, '2000-01-01', '2000-01-01')
  } catch (e) {
    return (e as Error).message
  }
  throw new Error(`engine accepted ${JSON.stringify(rule)}; the red-proof needs a refused shape`)
}

function engineCarryoverRefusal(rule: Record<string, unknown>): string {
  try {
    carryoverApplied(rule as never, '1', '2000-01-01', '2000-01-01')
  } catch (e) {
    return (e as Error).message
  }
  throw new Error(`engine accepted ${JSON.stringify(rule)}; the red-proof needs a refused shape`)
}

// The fold never throws; the write path raises the shape refusal through
// leavePolicyRuleProblem over the folded values, so the drawer's refusal is
// exactly that function's answer for the folded body.
function drawerRefusal(body: Record<string, unknown>): string {
  const folded = normalizeHrmLeavePolicyInput('leave-policies', body)
  const problem = leavePolicyRuleProblem({
    appliesTo: folded.appliesTo,
    accrualRule: folded.accrualRule,
    carryoverRule: folded.carryoverRule,
  })
  if (problem) return problem
  throw new Error(`drawer accepted ${JSON.stringify(body)}; the red-proof needs a refused shape`)
}

test('scope and rule slots fold into the stored jsonb before the column writer', () => {
  const folded = normalizeHrmLeavePolicyInput('leave-policies', {
    leaveTypeId: SUBSIDIARY,
    appliesEmployerSubsidiaryId: SUBSIDIARY,
    appliesDepartmentId: '',
    accrualKind: 'per_year',
    accrualHours: '120',
    accrualPeriodsPerYear: '',
    carryoverKind: 'carry_up_to',
    carryoverHours: '40',
    carryoverExpiresAfterDays: 90,
  })
  assert.deepEqual(folded, {
    leaveTypeId: SUBSIDIARY,
    appliesTo: { employer_subsidiary_id: SUBSIDIARY, department_id: null },
    accrualRule: { kind: 'per_year', hours: '120' },
    carryoverRule: { kind: 'carry_up_to', hours: '40', expires_after_days: 90 },
  })
})

test('blank scope pins fold to null for org-wide, and per-rule folds are independent', () => {
  const folded = normalizeHrmLeavePolicyInput('leave-policies', {
    accrualKind: 'per_period',
    accrualHours: '8',
    accrualPeriodsPerYear: 12,
  })
  assert.deepEqual(folded, {
    accrualRule: { kind: 'per_period', hours: '8', periods_per_year: 12 },
  })
})

test('slot keys win when both slots and a direct object arrive', () => {
  const folded = normalizeHrmLeavePolicyInput('leave-policies', {
    appliesTo: { employer_subsidiary_id: SUBSIDIARY, department_id: DEPARTMENT },
    appliesEmployerSubsidiaryId: '',
    appliesDepartmentId: '',
  })
  assert.deepEqual(folded, {
    appliesTo: { employer_subsidiary_id: null, department_id: null },
  })
})

test('bodies without slots and other entities pass through untouched', () => {
  const direct = { accrualRule: { kind: 'none' } }
  assert.equal(normalizeHrmLeavePolicyInput('leave-policies', direct), direct)
  const other = { name: 'x' }
  assert.equal(normalizeHrmLeavePolicyInput('departments', other), other)
})

test('direct rule objects fold whole-number strings before the probe', () => {
  // F9, same class as the benefit waiting period: an API caller sending the
  // rule object directly skips the drawer slots, so '30' must fold to 30
  // while '1.5' rides through to the shape refusal.
  assert.deepEqual(
    normalizeHrmLeavePolicyInput('leave-policies', {
      carryoverRule: { kind: 'carry_up_to', hours: '40', expires_after_days: '30' },
    }),
    { carryoverRule: { kind: 'carry_up_to', hours: '40', expires_after_days: 30 } },
  )
  assert.deepEqual(
    normalizeHrmLeavePolicyInput('leave-policies', {
      accrualRule: { kind: 'per_period', hours: '8', periods_per_year: '12' },
    }),
    { accrualRule: { kind: 'per_period', hours: '8', periods_per_year: 12 } },
  )
  assert.deepEqual(
    normalizeHrmLeavePolicyInput('leave-policies', {
      carryoverRule: { kind: 'carry_up_to', hours: '40', expires_after_days: '1.5' },
    }),
    { carryoverRule: { kind: 'carry_up_to', hours: '40', expires_after_days: '1.5' } },
  )
  assert.equal(
    leavePolicyRuleProblem({
      carryoverRule: { kind: 'carry_up_to', hours: '40', expires_after_days: '1.5' },
    }),
    'carryover expires_after_days is a non-negative integer of days — record the expiry',
    'the probe still refuses a raw bad spelling when called directly — the write path folds first',
  )
})

test('a per_year rule without hours is refused with the engine accrual words', () => {
  const expected = engineAccrualRefusal({ kind: 'per_year' })
  assert.equal(expected, 'a per_year accrual rule must carry hours — set hours or use kind none')
  assert.equal(
    drawerRefusal({ accrualKind: 'per_year', accrualHours: '' }),
    expected,
  )
})

test('a per_period rule without hours names per_period, not a generic accrual failure', () => {
  const expected = engineAccrualRefusal({ kind: 'per_period', periods_per_year: 12 })
  assert.equal(expected, 'a per_period accrual rule must carry hours — set hours or use kind none')
  assert.notEqual(
    expected,
    engineAccrualRefusal({ kind: 'per_year' }),
    'the two hour-less kinds must refuse in distinguishable words',
  )
  assert.equal(
    drawerRefusal({ accrualKind: 'per_period', accrualHours: '', accrualPeriodsPerYear: 12 }),
    expected,
  )
})

test('a per_period rule without periods_per_year is refused with the engine pro-rating words', () => {
  const expected = engineAccrualRefusal({ kind: 'per_period', hours: '8' })
  assert.equal(
    expected,
    'a per_period accrual rule must carry periods_per_year (a positive integer) — without it a period cannot be pro-rated',
  )
  assert.equal(
    drawerRefusal({ accrualKind: 'per_period', accrualHours: '8', accrualPeriodsPerYear: '' }),
    expected,
  )
})

test('a carry_up_to rule without hours is refused with the engine cap words', () => {
  const expected = engineCarryoverRefusal({ kind: 'carry_up_to' })
  assert.equal(expected, 'a carry_up_to rule must carry hours — set the cap or use kind carry_all')
  assert.equal(
    drawerRefusal({ carryoverKind: 'carry_up_to', carryoverHours: '' }),
    expected,
  )
})

test('a malformed accrual amount is refused with the engine exact-decimal words', () => {
  const expected = engineAccrualRefusal({ kind: 'per_year', hours: '7.555' })
  assert.match(expected, /at most 2 fraction digits/)
  assert.equal(
    drawerRefusal({ accrualKind: 'per_year', accrualHours: '7.555' }),
    expected,
  )
})

test('unknown kinds are refused by name before the engine probe', () => {
  assert.equal(
    leavePolicyRuleProblem({ accrualRule: { kind: 'hourly' } }),
    'accrual_rule kind is one of none, per_period, per_year, unlimited — record the rule',
  )
  assert.equal(
    leavePolicyRuleProblem({ carryoverRule: { kind: 'sometime' } }),
    'carryover_rule kind is one of none, carry_all, carry_up_to — record the rule',
  )
  assert.equal(
    leavePolicyRuleProblem({ accrualRule: 'per_year' }),
    'accrual_rule declares kind none, per_period, per_year, or unlimited — record the rule',
  )
})

test('a negative carryover expiry is refused by name', () => {
  assert.equal(
    leavePolicyRuleProblem({ carryoverRule: { kind: 'carry_all', expires_after_days: -1 } }),
    'carryover expires_after_days is a non-negative integer of days — record the expiry',
  )
  assert.equal(leavePolicyRuleProblem({ carryoverRule: { kind: 'carry_all' } }), null)
})

test('a malformed scope is refused by field name', () => {
  assert.equal(
    leavePolicyRuleProblem({ appliesTo: 'everywhere' }),
    'The applies-to filter must be a JSON object',
  )
  assert.equal(
    leavePolicyRuleProblem({
      appliesTo: { employer_subsidiary_id: 'not-a-uuid', department_id: null },
    }),
    'The applies-to subsidiary and department must be ids, or null for all',
  )
  assert.equal(
    leavePolicyRuleProblem({
      appliesTo: { employer_subsidiary_id: null, department_id: null },
    }),
    null,
  )
})
