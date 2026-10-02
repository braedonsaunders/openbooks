import assert from 'node:assert/strict'
import test from 'node:test'
import { completeBenefitPopulation, employeeBenefitAssignments, type BenefitParticipantInput } from './employee-benefits-types'

const programs = [{ id: 'rrsp', name: 'RRSP', type: 'retirement' }, { id: 'vac', name: 'Vacation', type: 'time_off' }, { id: 'recognition', name: 'Recognition', type: 'reward' }]
const participant = (nativeKind: BenefitParticipantInput['nativeKind'], programId: string): BenefitParticipantInput => ({ id: 'same-id', programId, nativeKind, employmentId: 'employment', employeePartyId: 'employee', employeeName: 'Nadia', status: 'active', effectiveFrom: '2026-01-01', effectiveTo: null })
const labels = { type: (type: string) => `Type ${type}`, status: (status: string) => `Status ${status}` }

test('coverage, vacation terms and recognition membership retain distinct identities and program ownership', () => {
  const rows = employeeBenefitAssignments(programs, [participant('enrollment', 'rrsp'), participant('vacation_terms', 'vac'), participant('membership', 'recognition')], labels)
  assert.equal(rows.length, 3)
  assert.equal(new Set(rows.map(row => row.id)).size, 3)
  for (const row of rows) {
    assert.equal(row.nativeId, 'same-id')
    assert.equal(row.employeePartyId, 'employee')
    assert.equal(row.programName, programs.find(program => program.id === row.programId)!.name)
    assert.equal(new URL(row.programHref, 'http://localhost').searchParams.get('program'), row.programId)
    assert.equal(new URL(row.employeeHref, 'http://localhost').searchParams.get('party'), 'employee')
  }
  assert.match(rows.find(row => row.nativeKind === 'enrollment')!.assignmentHref, /view=employees&enrollmentConfig=same-id/)
  assert.match(rows.find(row => row.nativeKind === 'vacation_terms')!.assignmentHref, /view=employees&vacationTerms=same-id/)
  assert.match(rows.find(row => row.nativeKind === 'membership')!.assignmentHref, /program=recognition&transactionTab=participants/)
})

test('an inaccessible program refuses the entire assignment view with an actionable scope remedy', () => {
  assert.throws(() => employeeBenefitAssignments(programs, [participant('enrollment', 'hidden')], labels), /no accessible program.*legal-employer scope/)
})

test('historical and future assignment dates are retained without inventing enrollment or ledger records', () => {
  const original = { ...participant('vacation_terms', 'vac'), effectiveFrom: '2027-01-01', effectiveTo: '2027-12-31' }
  const [row] = employeeBenefitAssignments(programs, [original], labels)
  assert.equal(row!.effectiveFrom, original.effectiveFrom)
  assert.equal(row!.effectiveTo, original.effectiveTo)
  assert.equal(row!.nativeKind, 'vacation_terms')
  assert.equal(row!.programTypeLabel, 'Type time_off')
  assert.deepEqual(employeeBenefitAssignments(programs, [], labels), [])
})

test('complete population traverses all service pages including a nonfull final page', async () => {
  const population = Array.from({ length: 1001 }, (_, index) => index)
  const offsets: number[] = []
  const rows = await completeBenefitPopulation(async ({ limit, offset }) => { offsets.push(offset); return population.slice(offset, offset + limit) })
  assert.deepEqual(rows, population)
  assert.deepEqual(offsets, [0, 500, 1000])
})

test('a refusal on a later service page is raised rather than returning a successful prefix', async () => {
  await assert.rejects(completeBenefitPopulation(async ({ offset }) => {
    if (offset > 0) throw new Error('Employee legal-employer scope was revoked; reload the employee record.')
    return Array.from({ length: 500 }, (_, index) => index)
  }), /scope was revoked; reload/)
})
