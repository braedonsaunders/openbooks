import assert from 'node:assert/strict'
import test from 'node:test'
import { nameFlowWarnings } from './warnings.ts'

// QA-057: "may not run as expected" warnings must name the node and the
// problem — a storage id alone means nothing on the canvas.
const names = new Map([
  ['trigger_1', 'Trigger: A record is submitted for approval'],
  ['action_9', 'Action: Notify'],
  ['gate_4', 'Approval: Manager sign-off'],
])

test('a kind-prefixed storage id becomes the display name with the problem kept', () => {
  const [named] = nameFlowWarnings(
    ['Trigger trigger_1 has no outgoing step — connect it to the first step or the flow never runs.'],
    names,
  )
  assert.ok(
    named?.startsWith('Trigger: A record is submitted for approval (trigger_1) has no outgoing step'),
    named,
  )
})

test('quoted node references and bare ids are named alike', () => {
  const [quoted, bare] = nameFlowWarnings(
    [
      'node "gate_4": before_post cannot create approval gates — configure posting approval on on_submit',
      'Node action_9: unreachable — not connected to any trigger.',
    ],
    names,
  )
  assert.ok(
    quoted?.startsWith('Approval: Manager sign-off (gate_4): before_post cannot create approval gates'),
    quoted,
  )
  assert.ok(
    bare?.startsWith('Action: Notify (action_9): unreachable'),
    bare,
  )
})

test('unknown ids and node-less warnings pass through untouched', () => {
  const [global, unknown] = nameFlowWarnings(
    ['Flow has no trigger — add a trigger node to start it.', 'Trigger trigger_zzz has no outgoing step.'],
    names,
  )
  assert.equal(global, 'Flow has no trigger — add a trigger node to start it.')
  assert.equal(unknown, 'Trigger trigger_zzz has no outgoing step.')
})

test('naming never double-wraps an already named reference', () => {
  const [named] = nameFlowWarnings(
    ['Trigger trigger_1 has no outgoing step; see trigger_1 on the canvas.'],
    names,
  )
  assert.equal(
    named,
    'Trigger: A record is submitted for approval (trigger_1) has no outgoing step; see Trigger: A record is submitted for approval (trigger_1) on the canvas.',
  )
})
