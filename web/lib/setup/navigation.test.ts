import assert from 'node:assert/strict'
import test from 'node:test'
import { clearSetupChildren, setupNavigationKeys, setupTabParams } from './navigation.ts'

test('nested configuration tabs retain the parent tab and selected contribution', () => {
  const params = new URLSearchParams({ program: 'plan', setupTab: 'benefit-contribution-rules', childRow: 'contribution' })
  const next = setupTabParams(params, 'benefit-contribution-rule-components', 'child')
  assert.equal(next.get('program'), 'plan')
  assert.equal(next.get('setupTab'), 'benefit-contribution-rules')
  assert.equal(next.get('childRow'), 'contribution')
  assert.equal(next.get('childTab'), 'benefit-contribution-rule-components')
  assert.equal(params.has('childTab'), false, 'navigation does not mutate the existing route state')
  assert.equal(setupNavigationKeys('child').childRow, 'childChildRow')
})

test('returning to contribution details clears only its descendant state', () => {
  const params = new URLSearchParams({ program: 'plan', setupTab: 'benefit-contribution-rules', childRow: 'contribution', childQ: 'RRSP',
    childTab: 'benefit-contribution-rule-components', childChildRow: 'component', childChildPage: '2', childChildChildRow: 'descendant' })
  const next = setupTabParams(params, 'details', 'child')
  assert.deepEqual(Object.fromEntries(next), { program: 'plan', setupTab: 'benefit-contribution-rules', childRow: 'contribution', childQ: 'RRSP' })
})

test('a parent tab change clears all previous descendants and retains its own filters', () => {
  const params = new URLSearchParams({ row: 'plan', q: 'parent', childRow: 'rule', childTab: 'counted', childQ: 'child', childPage: '3', childChildRow: 'component', childChildChildRow: 'descendant' })
  const next = setupTabParams(params, 'other')
  assert.deepEqual(Object.fromEntries(next), { row: 'plan', q: 'parent', setupTab: 'other' })
  clearSetupChildren(next)
  assert.equal(next.get('row'), 'plan')
})
