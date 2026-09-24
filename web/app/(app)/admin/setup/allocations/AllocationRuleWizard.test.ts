import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allowsUntagged,
  defaultWizardDraft,
  nextTargetWeight,
  sourceFilterComplete,
  wizardStepComplete,
} from './rule-wizard'

// The create wizard's source step gates on matcher-dimension semantics: a
// `specific` filter with no picked values cannot advance, while `any` and
// `untagged` are complete on their own. Hand-computed against the draft
// shape, never through the component.
test('a specific source filter is incomplete until values are picked', () => {
  assert.equal(sourceFilterComplete({ mode: 'any', ids: [] }), true)
  assert.equal(sourceFilterComplete({ mode: 'untagged', ids: [] }), true)
  assert.equal(sourceFilterComplete({ mode: 'specific', ids: [] }), false)
  assert.equal(sourceFilterComplete({ mode: 'specific', ids: ['dept-1'] }), true)
})

test('the source step cannot advance with an unpicked specific filter', () => {
  const draft = defaultWizardDraft()
  draft.name = 'Overhead split'
  draft.key = 'overhead-split'
  draft.sourceFilters.department = { mode: 'specific', ids: [] }
  assert.equal(wizardStepComplete('source', draft), false)
  draft.sourceFilters.department = { mode: 'specific', ids: ['dept-1'] }
  assert.equal(wizardStepComplete('source', draft), true)
})

test('untagged pooling is allowed only on taggable dimensions', () => {
  for (const key of ['department', 'location', 'class', 'project']) {
    assert.equal(allowsUntagged(key), true)
  }
  for (const key of ['party', 'item', 'subsidiary']) {
    assert.equal(allowsUntagged(key), false)
  }
})

test('the next target weight follows the row count', () => {
  const draft = defaultWizardDraft()
  assert.equal(nextTargetWeight(draft), '5')
  draft.targets = [{ valueId: 'a', weight: '1' }]
  assert.equal(nextTargetWeight(draft), '2')
  draft.targets = [
    { valueId: 'a', weight: '1' },
    { valueId: 'b', weight: '2' },
  ]
  assert.equal(nextTargetWeight(draft), '3')
})
