import assert from 'node:assert/strict'
import test from 'node:test'
import { componentLabel, isComponentIdentityMissing } from './kit-component-labels'

test('a component with code and name reads as code then name', () => {
  assert.equal(
    componentLabel({ id: '01a10c7f-b7b0-795b-93e8-a251334b1338', code: 'items-qa-COMP-A', name: 'Component A', isActive: true }),
    'items-qa-COMP-A · Component A',
  )
})

test('a component with only a name still names itself', () => {
  assert.equal(
    componentLabel({ id: '01a10c7f-b7b0-795b-93e8-a251334b1338', code: null, name: 'Component A', isActive: true }),
    'Component A',
  )
})

test('an inactive component keeps its name: absence from the picker is not absence from the recipe', () => {
  const line = { id: '01a10c7f-b7b0-795b-93e8-a251334b1338', code: 'items-qa-COMP-A', name: 'Component A', isActive: false }
  assert.equal(componentLabel(line), 'items-qa-COMP-A · Component A')
  assert.equal(isComponentIdentityMissing(line), false)
})

test('a line whose item row is gone falls back to a short storage id and reports missing', () => {
  const line = { id: '01a10c7f-b7b0-795b-93e8-a251334b1338', code: null, name: null, isActive: null }
  assert.equal(componentLabel(line), '01a10c7f')
  assert.equal(isComponentIdentityMissing(line), true)
})
