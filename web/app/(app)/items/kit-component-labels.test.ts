import assert from 'node:assert/strict'
import test from 'node:test'
import { componentLabel, isComponentIdentityMissing } from './kit-component-labels'

test('a component with code and name reads as code then name', () => {
  assert.equal(
    componentLabel({ componentItemId: '01a10c7f-b7b0-795b-93e8-a251334b1338', code: 'items-qa-COMP-A', name: 'Component A' }),
    'items-qa-COMP-A · Component A',
  )
})

test('a component with only a name still names itself', () => {
  assert.equal(
    componentLabel({ componentItemId: '01a10c7f-b7b0-795b-93e8-a251334b1338', code: null, name: 'Component A' }),
    'Component A',
  )
})

test('a component with only a code still names itself', () => {
  assert.equal(
    componentLabel({ componentItemId: '01a10c7f-b7b0-795b-93e8-a251334b1338', code: 'items-qa-COMP-A', name: null }),
    'items-qa-COMP-A',
  )
})

test('a line with no joined catalog row falls back to a short storage id', () => {
  assert.equal(
    componentLabel({ componentItemId: '01a10c7f-b7b0-795b-93e8-a251334b1338', code: null, name: null }),
    '01a10c7f',
  )
})

test('missing identity follows the explicit joined row id, never blank fields', () => {
  assert.equal(isComponentIdentityMissing(null), true)
  assert.equal(isComponentIdentityMissing('01a10c7f-b7b0-795b-93e8-a251334b1338'), false)
})
