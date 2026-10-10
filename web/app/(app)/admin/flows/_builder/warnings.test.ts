import assert from 'node:assert/strict'
import test from 'node:test'
import { nameFlowWarnings } from './warnings.ts'

// Storage ids must never reach the author: a known id becomes the canvas
// display name alone, and an id with no canvas card (a save error that
// outlived its node) reads as a removed step, never a bare id.
const names = new Map([
  ['trigger_1', 'Trigger: A record is submitted for approval'],
  ['action_9', 'Action: Notify'],
  ['gate_4', 'Approval: Manager sign-off'],
])

test('a kind-prefixed storage id becomes the display name with the problem kept', () => {
  const [named = ''] = nameFlowWarnings(
    ['Trigger trigger_1 has no outgoing step — connect it to the first step or the flow never runs.'],
    names,
  )
  assert.ok(
    named.startsWith('Trigger: A record is submitted for approval has no outgoing step'),
    named,
  )
  assert.ok(!named?.includes('trigger_1'), `no storage id may survive, got: ${named}`)
})

test('quoted node references and bare ids are named alike', () => {
  const [quoted = '', bare = ''] = nameFlowWarnings(
    [
      'node "gate_4": before_post cannot create approval gates — configure posting approval on on_submit',
      'Node action_9: unreachable — not connected to any trigger.',
    ],
    names,
  )
  assert.ok(
    quoted.startsWith('Approval: Manager sign-off: before_post cannot create approval gates'),
    quoted,
  )
  assert.ok(bare.startsWith('Action: Notify: unreachable'), bare)
})

test('references to deleted nodes read as removed steps, never bare ids', () => {
  const [kindPrefixed = '', engineStyle = '', bare = ''] = nameFlowWarnings(
    [
      'Trigger trigger_zzz has no outgoing step.',
      'node "cond_gone": unreachable — not connected to any trigger.',
      'Flow has no trigger — add a trigger node to start it.',
    ],
    names,
  )
  assert.equal(kindPrefixed, 'Trigger (removed step) has no outgoing step.')
  assert.ok(engineStyle.startsWith('a removed node:'), engineStyle)
  assert.ok(!engineStyle.includes('cond_gone'), `stale id must not survive, got: ${engineStyle}`)
  assert.equal(bare, 'Flow has no trigger — add a trigger node to start it.')
})

test('naming never double-wraps an already named reference', () => {
  const [named = ''] = nameFlowWarnings(
    ['Trigger trigger_1 has no outgoing step; see trigger_1 on the canvas.'],
    names,
  )
  assert.equal(
    named,
    'Trigger: A record is submitted for approval has no outgoing step; see Trigger: A record is submitted for approval on the canvas.',
  )
})
