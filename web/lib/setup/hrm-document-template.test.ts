import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeTemplateSlots, normalizeHrmDocumentTemplateInput } from './hrm-document-template'
import { SETUP_ENTITY_BY_KEY } from './registry'

/**
 * HR-19 document-template slot fold (pure): the Setup drawer edits
 * signer membership as three booleans plus a merge-key array, and the
 * fold emits the ordered signer_roles subset and the merge_fields array
 * before buildRow — the slot keys never reach the column writer.
 */

test('template normalize ignores other entities', () => {
  const body = { signEmployee: true }
  assert.equal(normalizeHrmDocumentTemplateInput('leave-policies', body), body)
})

test('template normalize passes through a body without slots', () => {
  const body = { name: 'Offer' }
  assert.equal(normalizeHrmDocumentTemplateInput('hrm-document-templates', body), body)
})

test('signer slots fold into the ordered role subset in canonical order', () => {
  const folded = normalizeHrmDocumentTemplateInput('hrm-document-templates', {
    name: 'Offer',
    signHr: true,
    signEmployee: true,
    signManager: false,
  })
  assert.deepEqual(folded.signerRoles, ['employee', 'hr'])
  assert.ok(!('signEmployee' in folded), 'slot keys must not reach the column writer')
  assert.ok(!('signManager' in folded), 'slot keys must not reach the column writer')
  assert.ok(!('signHr' in folded), 'slot keys must not reach the column writer')
})

test('an unchecked slot set folds to the empty role list, never undefined', () => {
  const folded = normalizeHrmDocumentTemplateInput('hrm-document-templates', {
    name: 'Policy',
    signEmployee: false,
  })
  assert.deepEqual(folded.signerRoles, [])
})

test('mergeFields ride through the fold untouched for the array writer', () => {
  const folded = normalizeHrmDocumentTemplateInput('hrm-document-templates', {
    name: 'Offer',
    mergeFields: ['employee_name'],
  })
  assert.deepEqual(folded.mergeFields, ['employee_name'])
})

test('mergeTemplateSlots prefers submitted slots over the stored row', () => {
  const merged = mergeTemplateSlots(
    { signer_roles: ['employee'], merge_fields: ['a'] },
    { signerRoles: ['manager'], mergeFields: ['b'] },
  )
  assert.deepEqual(merged, { signerRoles: ['manager'], mergeFields: ['b'] })
})

test('mergeTemplateSlots keeps the stored arrays on a partial edit', () => {
  const merged = mergeTemplateSlots(
    { signer_roles: ['employee', 'hr'], merge_fields: ['a'] },
    { name: 'Renamed' },
  )
  assert.deepEqual(merged, { signerRoles: ['employee', 'hr'], mergeFields: ['a'] })
})

test('mergeTemplateSlots treats a missing row as empty arrays', () => {
  const merged = mergeTemplateSlots(null, {})
  assert.deepEqual(merged, { signerRoles: [], mergeFields: [] })
})

test('document setup entities are gated and rehomed', () => {
  for (const [key, featureKey] of [
    ['hrm-document-categories', 'hrmDocuments'],
    ['hrm-document-templates', 'hrmDocuments'],
    ['hrm-retention-schedules', 'hrmDocumentRetention'],
  ] as const) {
    const entity = SETUP_ENTITY_BY_KEY.get(key)
    assert.ok(entity, `${key} must be registered`)
    assert.equal(entity.featureKey, featureKey, `${key} hides while the feature is off`)
    assert.equal(entity.rehomed, true, `${key} must be marked rehomed`)
  }
})
