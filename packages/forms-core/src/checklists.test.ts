import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checklistDocumentSchema,
  checklistIssues,
  emptyStepDesign,
  includedChecklistSteps,
  type ChecklistDocument,
} from './checklists'
import { splitRecordData, withComputedFormulas } from './record-data'
import { validateResponse } from './validator'
const one = '10000000-0000-4000-8000-000000000001',
  two = '10000000-0000-4000-8000-000000000002'
const step = (id: string, title: string) => ({
  id,
  title,
  description: null,
  ownerKind: 'manager' as const,
  ownerPartyId: null,
  dueOffsetDays: 0,
  required: true,
  evidenceKind: 'none' as const,
  design: emptyStepDesign(),
})
const doc = (): ChecklistDocument => ({
  name: 'New hire',
  kind: 'onboarding',
  appliesTo: { employerSubsidiaryId: null, departmentId: null },
  steps: [step(one, 'Prepare access'), step(two, 'Welcome employee')],
})
test('publication identifies missing titles, unsafe resources and named-owner omissions', () => {
  const d = doc()
  d.steps[0]!.title = ''
  d.steps[0]!.ownerKind = 'named_party'
  d.steps[0]!.design.resources = [{ label: 'Policy', url: 'javascript:alert(1)' }]
  const issues = checklistIssues(d)
  assert.ok(issues.some((i) => i.stepId === one && /title/.test(i.message)))
  assert.ok(issues.some((i) => /named owner/.test(i.message)))
  assert.ok(issues.some((i) => /HTTP or HTTPS/.test(i.message)))
})
test('cycles and references to another checklist cannot publish', () => {
  const d = doc()
  d.steps[0]!.design.dependencies = [two]
  d.steps[1]!.design.dependencies = [one]
  assert.ok(checklistIssues(d).some((i) => /cycle/.test(i.message)))
  d.steps[1]!.design.dependencies = ['10000000-0000-4000-8000-000000000099']
  assert.ok(checklistIssues(d).some((i) => /another step in this checklist/.test(i.message)))
})
test('conditions resolve deterministically and refuse an excluded prerequisite by task name', () => {
  const d = doc()
  d.steps[0]!.design.condition = { op: 'eq', field: 'departmentId', value: one }
  d.steps[1]!.design.dependencies = [one]
  assert.deepEqual(
    includedChecklistSteps(d, { departmentId: one }).map((s) => s.title),
    ['Prepare access', 'Welcome employee'],
  )
  assert.throws(
    () => includedChecklistSteps(d, { departmentId: two }),
    /Welcome employee.*depends on a step excluded/,
  )
  d.steps[1]!.design.condition = { op: 'eq', field: 'departmentId', value: one }
  assert.throws(() => includedChecklistSteps(d, { departmentId: two }), /exclude every step/)
})
test('drafts may contain unfinished resource links; publication names the remedy', () => {
  const d = doc()
  d.steps[0]!.design.resources = [{ label: 'Handbook', url: '' }]
  assert.equal(checklistDocumentSchema.safeParse(d).success, true)
  assert.ok(checklistIssues(d).some((i) => /remove the unfinished link/.test(i.message)))
})
test('shared form runtime computes formulas and validates repeating response rows', () => {
  const form = {
    schemaVersion: 1 as const,
    title: 'Returned equipment',
    sections: [
      {
        id: 'equipment',
        repeating: true,
        minRows: 1,
        fields: [{ id: 'item', type: 'text' as const, label: 'Asset', required: true }],
      },
    ],
  }
  const { values, rows } = splitRecordData(
    form.sections,
    withComputedFormulas(form.sections, { equipment: [{ item: '' }] }),
  )
  assert.ok(validateResponse(form, values, rows).some((e) => e.fieldId.includes('item')))
  assert.equal(validateResponse(form, {}, { equipment: [{ item: 'Laptop' }] }).length, 0)
})

test('actionable work waits for prerequisites and approvals and orders ready steps deterministically', async () => {
  const { actionableChecklistSteps } = await import('./checklists')
  const first = {
    id: one,
    sourceStepId: one,
    status: 'pending',
    dueOn: '2026-10-01',
    position: 0,
    design: emptyStepDesign(),
  }
  const dependent = {
    ...first,
    id: two,
    sourceStepId: two,
    position: 1,
    design: { ...emptyStepDesign(), dependencies: [one] },
  }
  const waiting = { ...first, id: 'waiting', sourceStepId: null, approvalStatus: 'pending' }
  const missing = {
    ...dependent,
    id: 'missing',
    design: { ...emptyStepDesign(), dependencies: ['not-present'] },
  }
  assert.deepEqual(
    actionableChecklistSteps([dependent, waiting, missing, first]).map((s) => s.id),
    [one],
  )
  assert.deepEqual(
    actionableChecklistSteps([dependent, { ...first, status: 'done' }]).map((s) => s.id),
    [two],
  )
  assert.deepEqual(
    actionableChecklistSteps([{ ...dependent, design: emptyStepDesign() }, first]).map((s) => s.id),
    [one, two],
  )
})
test('publication refuses unsupported form types and invalid condition operands with an actionable remedy', () => {
  const d = doc()
  d.steps[0]!.design.form = {
    schemaVersion: 1,
    title: 'Evidence',
    sections: [{ id: 'evidence', fields: [{ id: 'file', type: 'file', label: 'Attachment' }] }],
  }
  d.steps[0]!.design.condition = { op: 'eq', field: 'departmentId', value: 'unknown' }
  const issues = checklistIssues(d)
  assert.ok(issues.some((i) => /File Cabinet evidence/.test(i.message)))
  assert.ok(issues.some((i) => /condition picker/.test(i.message)))
})
