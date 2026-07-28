import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applySearchInputEdit,
  createSearchInputEditState,
  reconcileSearchInputUrl,
} from './search-input-state.ts'

test('an older async search response cannot replace newer input', () => {
  let state = createSearchInputEditState('')
  state = applySearchInputEdit('a', '', false)
  state = applySearchInputEdit('ab', '', true)

  state = reconcileSearchInputUrl(state, 'a', true)
  assert.deepEqual(state, { value: 'ab', dirty: true })

  state = reconcileSearchInputUrl(state, 'ab', false)
  assert.deepEqual(state, { value: 'ab', dirty: false })
})

test('out-of-order responses remain subordinate until all navigation settles', () => {
  let state = applySearchInputEdit('project', '', false)

  state = reconcileSearchInputUrl(state, 'project', true)
  assert.deepEqual(state, { value: 'project', dirty: true })

  state = reconcileSearchInputUrl(state, 'pro', true)
  assert.deepEqual(state, { value: 'project', dirty: true })

  state = reconcileSearchInputUrl(state, 'project', false)
  assert.deepEqual(state, { value: 'project', dirty: false })
})

test('clearing back to the visible URL still resists an in-flight old response', () => {
  let state = applySearchInputEdit('old request', '', false)
  state = applySearchInputEdit('', '', true)
  assert.deepEqual(state, { value: '', dirty: true })

  state = reconcileSearchInputUrl(state, 'old request', false)
  assert.deepEqual(state, { value: '', dirty: true })

  state = reconcileSearchInputUrl(state, '', false)
  assert.deepEqual(state, { value: '', dirty: false })
})

test('external URL changes update the input when there is no local edit', () => {
  const state = reconcileSearchInputUrl(
    createSearchInputEditState('active'),
    'archived',
    false,
  )

  assert.deepEqual(state, { value: 'archived', dirty: false })
})
