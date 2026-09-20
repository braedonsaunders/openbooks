import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeHrmProcessTemplateInput } from './hrm-process-template'

test('template filter slots fold into applies_to before the column writer', () => {
  const folded = normalizeHrmProcessTemplateInput('hrm-process-templates', {
    kind: 'onboarding',
    name: 'Day one',
    appliesEmployerSubsidiaryId: '00000000-0000-4000-8000-000000000001',
    appliesDepartmentId: '',
  })
  assert.deepEqual(folded, {
    kind: 'onboarding',
    name: 'Day one',
    appliesTo: {
      employer_subsidiary_id: '00000000-0000-4000-8000-000000000001',
      department_id: null,
    },
  })
})

test('bodies without slots and other entities pass through untouched', () => {
  const direct = { kind: 'transfer', appliesTo: { employer_subsidiary_id: null, department_id: null } }
  assert.equal(normalizeHrmProcessTemplateInput('hrm-process-templates', direct), direct)
  const other = { name: 'x' }
  assert.equal(normalizeHrmProcessTemplateInput('departments', other), other)
})

test('slot keys win when both slots and a direct object arrive', () => {
  const folded = normalizeHrmProcessTemplateInput('hrm-process-templates', {
    appliesTo: { employer_subsidiary_id: '00000000-0000-4000-8000-000000000001', department_id: null },
    appliesEmployerSubsidiaryId: '',
    appliesDepartmentId: '',
  })
  assert.deepEqual(folded, { appliesTo: { employer_subsidiary_id: null, department_id: null } })
})
